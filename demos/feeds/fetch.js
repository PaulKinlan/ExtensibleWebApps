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
// http://. On a Node server the platform also keeps it off the server's own
// network (src/server/network-guard.ts), so an address someone typed can't
// reach the machine it runs on.

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
 */
function parse(xml, url) {
  let text = String(xml);
  const root = /<(?:([\w-]+):)?(rss|feed|RDF)\b([^>]*)>/i.exec(text);
  if (!root) throw new Error("That isn't an RSS or Atom feed");
  // An Atom feed may name its elements with a prefix (<atom:feed>, <atom:entry>): read them without it.
  if (root[1] && root[2].toLowerCase() === "feed") text = text.replace(new RegExp(`<(/?)${root[1]}:`, "g"), "<$1");
  const feedBase = baseOf(root[3], url);
  const entries = [...text.matchAll(/<(item|entry)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map((m) => ({ body: m[3], base: baseOf(m[2], feedBase) }));
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

/** What's inside the first <name>…</name>, CDATA unwrapped. */
function tag(xml, name) {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
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
  const atom = [...entry.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => ({ href: /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1], rel: /\brel\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1] })).filter((l) => l.href);
  const written = decode((atom.find((l) => !l.rel || l.rel === "alternate") ?? atom[0])?.href ?? tag(entry, "link")).trim();
  if (!written) return "";
  let link;
  try {
    link = new URL(written, base).href;
  } catch {
    return "";
  }
  return /^https?:\/\//i.test(link) ? link.slice(0, 2000) : "";
}

/** A title: text, so "&lt;story&gt;" stays as the words "<story>". Any tags (from CDATA) are taken out first. */
function words(text) {
  return decode(String(text).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** A summary, which feeds often send as escaped HTML: text with any HTML taken out, entities decoded and spaces made single. */
function plain(html) {
  return decode(
    decode(String(html))
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** The named entities feeds use most, beyond XML's five: curly quotes, dashes, the ellipsis. */
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", mdash: "—", ndash: "–", bull: "•", middot: "·",
  copy: "©", reg: "®", trade: "™", deg: "°", laquo: "«", raquo: "»", times: "×", euro: "€", pound: "£",
};

function decode(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") {
      const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return NAMED[k] ?? all;
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
