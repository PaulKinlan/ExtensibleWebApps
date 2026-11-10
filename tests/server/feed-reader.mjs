// The site's feed reader (src/server/feed-reader.ts), on both hosts: what it
// refuses, over HTTP to the running server, and what it answers, with a
// stand-in for the network (the hosts' own requests are checked by the
// refusals: http://, the server's own network, another site's pages).
import { feedReader, parse } from "../../src/server/feed-reader.ts";
// The Feeds demo's server plugin reads feeds the same way, in a space (a plugin is one file, so it has its own copy).
import { parse as pluginParse } from "../../demos/feeds/fetch.js";

export async function feedReaderChecks(base, check, host) {
  const ask = (url, headers = {}) => fetch(`${base}/feed-reader?url=${encodeURIComponent(url)}`, { headers }).then(async (r) => ({ status: r.status, type: r.headers.get("content-type"), body: await r.json().catch(() => null) }));
  const plain = await ask("http://example.com/feed.xml");
  const own = await ask("https://10.0.0.1/feed.xml");
  const local = await ask("https://localhost/feed.xml");
  const elsewhere = await ask("https://example.com/feed.xml", { origin: "https://elsewhere.example" });
  const cross = await ask("https://example.com/feed.xml", { "sec-fetch-site": "cross-site" });
  check(
    `feed reader (${host}): /feed-reader needs no sign-in, and refuses http://, the server's own network and other sites' pages`,
    plain.status === 400 && /https/.test(plain.body?.error) && own.status === 502 && /own network/.test(own.body?.error) && local.status === 502 && /own network/.test(local.body?.error) && elsewhere.status === 403 && cross.status === 403 && /json/.test(plain.type ?? ""),
    JSON.stringify({ plain, own, local, elsewhere, cross }),
  );
  if (host === "cloudflare") {
    // A name that leads inside is refused too, by what the resolver says (tests/server/fake-dns.mjs).
    const named = await ask("https://inside.example/feed.xml");
    check("feed reader (cloudflare): a feed whose name leads to a private address is refused, as on Node", named.status === 502 && /own network/.test(named.body?.error), JSON.stringify(named));
  }
  if (host !== "node") return;

  // What it answers, with the network stood in for: text only, entities as characters, unsafe links dropped.
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Local &amp; news</title>
<item><title>That&amp;rsquo;s it</title><link>https://example.com/1</link><guid>one</guid><pubDate>Sat, 07 Nov 2026 09:00:00 GMT</pubDate><description><![CDATA[<p>I&rsquo;m <b>here</b>&hellip;<script>alert(1)</script></p>]]></description></item>
<item><title>Second</title><link>javascript:alert(1)</link><guid>two</guid></item>
</channel></rss>`;
  const hops = [];
  const get = async (url) => {
    hops.push(url.href);
    if (url.pathname === "/moved") return new Response(null, { status: 301, headers: { location: "/feed.xml" } });
    if (url.pathname === "/away") return new Response(null, { status: 302, headers: { location: "http://example.com/feed.xml" } });
    if (url.pathname === "/page") return new Response("<html><script>alert(1)</script></html>");
    return new Response(rss);
  };
  const read = (url) => feedReader(new Request(`https://site.example/feed-reader?url=${encodeURIComponent(url)}`, { headers: { "sec-fetch-site": "same-origin" } }), get).then(async (r) => ({ status: r.status, csp: r.headers.get("content-security-policy"), body: await r.json() }));
  const feed = await read("https://feeds.example/moved");
  const [first, second] = feed.body.items ?? [];
  const page = await read("https://feeds.example/page");
  const away = await read("https://feeds.example/away");
  check(
    "feed reader: answers a feed's text only (after a redirect), with entities as characters and only http(s) links, and refuses what isn't a feed or leaves https",
    feed.status === 200 && /sandbox/.test(feed.csp ?? "") && feed.body.url === "https://feeds.example/feed.xml" && feed.body.title === "Local & news" && first?.title === "That’s it" && first.summary === "I’m here …" && first.link === "https://example.com/1" && second?.link === "" && page.status === 502 && /isn't an RSS/.test(page.body.error) && away.status === 502 && /away from https/.test(away.body.error),
    JSON.stringify({ feed, page, away, hops }),
  );

  // Feeds made to be slow to read: each takes one pass, not a pass per unclosed tag.
  const slow = {
    items: `<rss>${"<item>".repeat(300_000)}`,
    titles: `<rss><item>${"<title>x".repeat(200_000)}</item></rss>`,
    tags: `<rss><item><description>${"&lt;b".repeat(300_000)}</description><title>${"<i".repeat(300_000)}</title></item></rss>`,
    cdata: `<rss><item><title>${"<![CDATA[".repeat(150_000)}</title></item></rss>`,
    roots: "<rss".repeat(400_000),
  };
  const took = {};
  for (const [name, xml] of Object.entries(slow)) {
    const at = performance.now();
    try {
      parse(xml, "https://feeds.example/");
    } catch {}
    took[name] = Math.round(performance.now() - at);
  }
  check("feed reader: a feed made to be slow to read (many tags left open) is read in one pass", Object.values(took).every((ms) => ms < 1500), JSON.stringify(took));

  // The Feeds demo's server plugin (demos/feeds/fetch.js) reads as the site's reader does: the same answer for
  // the same feed, and the same single pass over a feed made to be slow.
  const atom = `<?xml version="1.0"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xml:base="https://blog.example/"><atom:title>An &amp; Atom feed</atom:title>
<atom:entry><atom:title type="html">&lt;b&gt;Bold&lt;/b&gt; &amp;mdash; news</atom:title><atom:link rel="self" href="/self"/><atom:link rel="alternate" href="posts/1"/><atom:id>tag:1</atom:id><atom:updated>2026-11-08T10:00:00Z</atom:updated><atom:summary><![CDATA[<!-- hidden --><style>p{}</style><p>Hello <a href="x">there</a></p>]]></atom:summary></atom:entry>
<atom:entry xml:base="https://other.example/"><atom:title>Second</atom:title><atom:link href="two"/><atom:published>2026-11-07T10:00:00Z</atom:published><atom:content>&lt;script&gt;alert(1)&lt;/script&gt;Kept &sbquo;words&rsquo;</atom:content></atom:entry>
<atom:entry><atom:title>Left open</atom:title>
</atom:feed>`;
  const same = [rss, atom].map((xml) => {
    const site = parse(xml, "https://feeds.example/feed.xml");
    const plugin = pluginParse(xml, "https://feeds.example/feed.xml");
    const newest = (items) => items.toSorted((a, b) => (b.published || "").localeCompare(a.published || ""));
    return { ok: JSON.stringify({ title: site.title, items: site.items }) === JSON.stringify({ title: plugin.title, items: newest(plugin.items) }) && site.items.length >= 2, site, plugin };
  });
  let notAFeed = "";
  try {
    pluginParse("<html></html>", "https://feeds.example/");
  } catch (error) {
    notAFeed = error.message;
  }
  const pluginTook = {};
  for (const [name, xml] of Object.entries(slow)) {
    const at = performance.now();
    try {
      pluginParse(xml, "https://feeds.example/");
    } catch {}
    pluginTook[name] = Math.round(performance.now() - at);
  }
  check(
    "feeds demo: its server plugin reads a feed as the site's reader does (the same titles, links, dates and plain summaries), and reads a feed made to be slow in one pass too",
    same.every((s) => s.ok) && /isn't an RSS/.test(notAFeed) && Object.values(pluginTook).every((ms) => ms < 1500),
    JSON.stringify({ same: same.filter((s) => !s.ok), notAFeed, pluginTook }),
  );
}
