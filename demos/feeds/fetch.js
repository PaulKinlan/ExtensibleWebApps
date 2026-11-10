// Fetch: the feed reader's server side, on the space's server only. It reads
// the `feeds` collection (feeds.js owns it), fetches each feed over https,
// and keeps what it finds in two collections of its own:
//
//   items    one record a story: its feed, title, link, date and a summary
//   fetched  one record a feed: its title, when it was last read, and what
//            went wrong, if anything did
//
// It reads every feed when it starts, every half hour after that, and a feed
// as soon as someone adds it. What it writes comes to every member's device
// as a change by plugin:fetch, so the stories are there offline too.
//
// Only https: a feed at http:// is refused, and so is one that redirects to
// http://. The platform also keeps it off the server's own network, on Node
// (src/server/network-guard.ts) and on Cloudflare
// (src/server/cloudflare/network-guard.ts), so an address someone typed can't
// reach the machine it runs on, whether it is written as an address or as a
// name that leads to one.

export const manifest = {
  id: "fetch",
  name: "Feed fetcher",
  description: "Reads each feed over https on the space's server, every half hour, and keeps the stories.",
  version: "1.0.0",
  runs: "server",
  permissions: ["network", "schedule", "data:read:feeds"],
  collections: {
    items: {
      title: "Stories",
      schema: {
        type: "object",
        required: ["feed", "title"],
        properties: {
          feed: { type: "string", title: "Feed" },
          title: { type: "string", title: "Title", maxLength: 300 },
          link: { type: "string", title: "Link", maxLength: 2000 },
          published: { type: "string", title: "Published" },
          summary: { type: "string", title: "Summary", maxLength: 400 },
        },
      },
    },
    fetched: {
      title: "Feeds read",
      schema: {
        type: "object",
        properties: {
          title: { type: "string", title: "Title", maxLength: 200 },
          at: { type: "string", title: "Last read" },
          error: { type: "string", title: "What went wrong", maxLength: 300 },
          count: { type: "number", title: "Stories" },
        },
      },
    },
  },
};

const EVERY = 30 * 60 * 1000;
const KEEP = 50;
const MAX_BYTES = 2_000_000;
const TIMEOUT = 15_000;

export default async function (ctx) {
  /** One feed at a time, so two reads of the same feed don't both add its stories. */
  let reading = Promise.resolve();
  const inTurn = (work) => {
    const turn = reading.then(work);
    reading = turn.catch(() => {});
    return turn;
  };

  const read = (feed) =>
    inTurn(async () => {
      try {
        // A read waits its turn: by then the feed may have been taken away, or given a new address.
        const now = (await ctx.call("data", "list", "feeds")).find((f) => f.id === feed.id);
        if (!now || now.url !== feed.url) return;
        const { title, items } = parse(...(await download(feed.url)));
        const had = new Set((await ctx.call("data", "list", "items")).filter((i) => i.feed === feed.id).map((i) => i.id));
        let added = 0;
        // Newest first, whatever order the feed lists them in; a story with no date goes last.
        const newest = items.toSorted((a, b) => (b.published || "").localeCompare(a.published || ""));
        for (const item of newest.slice(0, KEEP)) {
          // Short whatever the feed's id: a record's id is at most 64 characters.
          const id = `${hash(feed.id)}-${hash(item.key)}${hash(`\n${item.key}`)}`;
          if (had.has(id)) continue;
          await ctx.call("data", "put", "items", { id, feed: feed.id, title: item.title, link: item.link, published: item.published, summary: item.summary });
          added++;
        }
        await trim(feed.id);
        await ctx.call("data", "put", "fetched", { id: feed.id, title: title || feed.url, at: new Date().toISOString(), count: items.length });
        if (added) ctx.log(`${title || feed.url}: ${added} new`);
      } catch (error) {
        await ctx.call("data", "put", "fetched", { id: feed.id, at: new Date().toISOString(), error: String(error?.message ?? error).slice(0, 300) });
      }
    });

  /** Keeps a feed's newest stories, and lets the rest go. */
  const trim = async (feed) => {
    const mine = (await ctx.call("data", "list", "items")).filter((i) => i.feed === feed).sort((a, b) => (b.published ?? b.createdAt).localeCompare(a.published ?? a.createdAt));
    for (const old of mine.slice(KEEP)) await ctx.call("data", "delete", "items", old.id);
  };

  /** A feed taken away: its stories and its record go too. */
  const forget = (feed) =>
    inTurn(async () => {
      for (const item of (await ctx.call("data", "list", "items")).filter((i) => i.feed === feed)) await ctx.call("data", "delete", "items", item.id);
      await ctx.call("data", "delete", "fetched", feed);
    });

  const readAll = async () => {
    for (const feed of await ctx.call("data", "list", "feeds")) await read(feed);
  };

  // A feed someone adds is read straight away; one they take away is forgotten.
  ctx.on("data:changed:feeds", (change) => {
    if (change.after && change.after.url !== change.before?.url) void read(change.after);
    if (!change.after && change.before) void forget(change.before.id);
  });
  ctx.schedule.every("refresh", EVERY, readAll);
  await readAll();
}

/** The feed's text, over https only, at most MAX_BYTES of it, and the address it came from after any redirects. */
async function download(url) {
  if (!/^https:\/\//i.test(String(url))) throw new Error("Only https:// feeds are read");
  // Redirects are followed here, a hop at a time, so one to http:// is refused before it is fetched.
  const signal = AbortSignal.timeout(TIMEOUT);
  let answer;
  for (let hops = 0; ; hops++) {
    answer = await fetch(url, { redirect: "manual", headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" }, signal });
    const to = answer.status >= 300 && answer.status < 400 ? answer.headers.get("location") : null;
    if (!to) break;
    if (hops >= 5) throw new Error("The feed redirected too many times");
    url = new URL(to, url).href;
    if (!url.startsWith("https://")) throw new Error("The feed redirected away from https://");
  }
  if (!answer.ok) throw new Error(`The feed answered ${answer.status}`);
  const reader = answer.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("The feed is too big");
    }
    chunks.push(value);
  }
  return [new TextDecoder().decode(concat(chunks)), url];
}

function concat(chunks) {
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) (all.set(c, at), (at += c.length));
  return all;
}

/**
 * An RSS or Atom feed's title and stories, read with patterns: a server plugin has no DOMParser. Only text
 * comes out (titles, a plain summary, a link), so nothing in a feed is ever shown as HTML. `url` is where the
 * feed came from, for the links in it that are relative.
 *
 * It is the same reading as the site's own feed reader (src/server/feed-reader.ts), kept in step with it by a
 * check (tests/server/feed-reader.mjs): every step is a single pass over the text, with no pattern that
 * rescans the rest of the feed for each unclosed tag. So a feed made to be slow to read (many `<item>`s or
 * `<title>`s never closed) takes as long as a plain one of its size, and can't hold up the other feeds.
 */
export function parse(xml, url) {
  let text = String(xml);
  const root = /<(?:([\w-]{1,40}):)?(rss|feed|RDF)\b([^<>]{0,2000})>/i.exec(text);
  if (!root) throw new Error("That isn't an RSS or Atom feed");
  // An Atom feed may name its elements with a prefix (<atom:feed>, <atom:entry>): read them without it.
  if (root[1] && root[2].toLowerCase() === "feed") text = text.replace(new RegExp(`<(/?)${root[1]}:`, "g"), "<$1");
  const feedBase = baseOf(root[3], url);
  const entries = entriesOf(text).map((e) => ({ body: e.body, base: baseOf(e.attributes, feedBase) }));
  const first = text.search(/<(item|entry)\b/i);
  const head = first < 0 ? text : text.slice(0, first);
  const items = entries.map(({ body: entry, base }) => {
    const title = words(tag(entry, "title")).slice(0, 300) || "(untitled)";
    const link = linkOf(entry, base);
    const published = date(tag(entry, "pubDate") || tag(entry, "published") || tag(entry, "updated") || tag(entry, "dc:date"));
    const summary = plain(tag(entry, "description") || tag(entry, "summary") || tag(entry, "content")).slice(0, 400);
    return { key: tag(entry, "guid") || tag(entry, "id") || link || title, title, link, published, summary };
  });
  return { title: words(tag(head, "title")).slice(0, 200), items };
}

/** Each <item> or <entry>: its attributes and what's inside, in one pass. One left open ends the list. */
function entriesOf(text) {
  const found = [];
  const marks = /<(\/?)(item|entry)\b([^<>]{0,2000})>/gi;
  let open = null;
  for (let m = marks.exec(text); m; m = marks.exec(text)) {
    const name = m[2].toLowerCase();
    if (!m[1] && !open) open = { name, attributes: m[3], from: marks.lastIndex };
    else if (m[1] && open?.name === name) {
      found.push({ attributes: open.attributes, body: text.slice(open.from, m.index) });
      open = null;
    }
  }
  return found;
}

/** What's inside the first <name>…</name>, CDATA unwrapped: found with one forward search for each end. */
function tag(xml, name) {
  const start = new RegExp(`<${name}\\b[^<>]{0,2000}>`, "i").exec(xml);
  if (!start) return "";
  const from = start.index + start[0].length;
  const end = new RegExp(`</${name}\\s*>`, "ig");
  end.lastIndex = from;
  const close = end.exec(xml);
  return close ? cdata(xml.slice(from, close.index)).trim() : "";
}

/** Text with each <![CDATA[…]]> unwrapped; one left open runs to the end. */
function cdata(text) {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("<![CDATA[", at);
    if (open < 0) return out + text.slice(at);
    out += text.slice(at, open);
    const close = text.indexOf("]]>", open + 9);
    if (close < 0) return out + text.slice(open + 9);
    out += text.slice(open + 9, close);
    at = close + 3;
  }
}

/** HTML's text: tags, comments, scripts and styles taken out, in one pass. Anything left unclosed is dropped. */
function strip(html) {
  // Only A to Z, so `lower` is as long as `html` and a place in one is the same place in the other
  // (toLowerCase makes some letters longer: İ becomes two characters).
  const lower = html.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  let out = "";
  let at = 0;
  for (;;) {
    const lt = html.indexOf("<", at);
    if (lt < 0) return out + html.slice(at);
    out += html.slice(at, lt) + " ";
    let end;
    if (lower.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      end = close < 0 ? -1 : close + 2;
    } else if (/^<(script|style)\b/.test(lower.slice(lt, lt + 8))) {
      const name = lower.startsWith("<script", lt) ? "script" : "style";
      const close = lower.indexOf(`</${name}`, lt);
      end = close < 0 ? -1 : html.indexOf(">", close);
    } else end = html.indexOf(">", lt);
    if (end < 0) return out;
    at = end + 1;
  }
}

/** The address an element's xml:base attribute (in `attributes`) gives, against `base`; `base` if it has none. */
function baseOf(attributes, base) {
  const given = /\bxml:base\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1];
  try {
    return given ? new URL(decode(given), base).href : base;
  } catch {
    return base;
  }
}

/** A story's link: RSS's <link>text</link>, or Atom's <link href> (the alternate one, if it says), against `base`. Only http(s). */
function linkOf(entry, base) {
  const atom = [...entry.matchAll(/<link\b([^<>]{0,2000})>/gi)]
    .map((m) => ({ href: /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1], rel: /\brel\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1] }))
    .filter((l) => l.href);
  const written = decode((atom.find((l) => !l.rel || l.rel === "alternate") ?? atom[0])?.href ?? tag(entry, "link")).trim();
  if (!written) return "";
  try {
    const link = new URL(written, base).href;
    return /^https?:\/\//i.test(link) ? link.slice(0, 2000) : "";
  } catch {
    return "";
  }
}

/** A title: text, so "&lt;story&gt;" stays as the words "<story>". Any tags (from CDATA) are taken out first. */
function words(text) {
  return decode(decode(strip(String(text))))
    .replace(/\s+/g, " ")
    .trim();
}

/** A summary, which feeds often send as escaped HTML: text with any HTML taken out, entities decoded and spaces made single. */
function plain(html) {
  // A summary is cut to 400 characters, so only its start is read.
  return decode(strip(decode(String(html).slice(0, 50_000))))
    .replace(/\s+/g, " ")
    .trim();
}

/** The named entities feeds use most, beyond XML's five: curly quotes, dashes, the ellipsis. */
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", sbquo: "‚", bdquo: "„", prime: "′", Prime: "″",
  hellip: "…", mdash: "—", ndash: "–", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", deg: "°",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", times: "×", divide: "÷", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶",
};

function decode(text) {
  return String(text).replace(/&(#x[0-9a-f]{1,8}|#\d{1,10}|[a-z]{1,32});/gi, (all, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? all;
  });
}

/** An ISO date, or "" when the feed's date can't be read. */
function date(text) {
  const t = Date.parse(text);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

/** A short, stable name for a story (FNV-1a). */
function hash(text) {
  let h = 0x811c9dc5;
  for (const c of String(text)) h = Math.imul(h ^ c.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(36);
}
