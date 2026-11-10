// The site's feed reader: GET /feed-reader?url=https://… reads one public
// RSS or Atom feed and answers with its text, as JSON:
//
//   { url, title, items: [{ key, title, link, published, summary }] }
//
// It is how the Feeds demo (demos/feeds/) works for someone who has no space
// and isn't signed in: most sites don't let a page read their feed directly
// (no CORS), so the page asks the site it came from. In a space, the space's
// server reads the feeds itself (demos/feeds/fetch.js) and this isn't used.
//
// It is narrow on purpose, so it isn't a way to fetch anything for anyone:
//
//   - https only, a redirect at a time, and never to the server's own
//     network (each host gives a `get` that refuses it: on Node by the
//     address a name looks up to, on Cloudflare by the host as written
//     and by the addresses a resolver gives for a name);
//   - at most 2 MB, within 15 seconds, and only something that is a feed;
//   - only text comes back: titles, http(s) links, dates and plain
//     summaries with any HTML taken out, never the feed's own bytes, so
//     nothing from another site is ever served from this one's origin;
//   - from this site's pages only (a browser's Origin and Sec-Fetch-Site),
//     and a feed read in the last ten minutes is answered from memory.
//
// Node (serve.ts) and Cloudflare (cloudflare/worker.ts) both answer it here;
// the front door (front-door.ts) sends it.

/** Where the reader answers. */
export const FEED_READER = "/feed-reader";

/** A request, one hop: the host's own fetch, which refuses the server's own network and follows no redirect. */
export type Get = (url: URL, signal: AbortSignal) => Promise<Response>;

const MAX_BYTES = 2_000_000;
const TIMEOUT = 15_000;
const HOPS = 5;
const KEEP = 50;
const FRESH = 10 * 60 * 1000;
const REMEMBERED = 200;

/** What a feed said, kept for FRESH: the newest REMEMBERED feeds. */
const memory = new Map<string, { at: number; body: string }>();

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};
const answer = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers });

/** Answers a request to FEED_READER. */
export async function feedReader(request: Request, get: Get): Promise<Response> {
  if (request.method !== "GET") return answer(405, { error: "Only GET" });
  const here = new URL(request.url);
  // A page on another site may not use it: a browser says where a request came from.
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if ((origin && safeHost(origin) !== here.host) || (site && site !== "same-origin")) return answer(403, { error: "Only this site's pages may use its feed reader" });
  let url: URL;
  try {
    url = new URL(here.searchParams.get("url") ?? "");
  } catch {
    return answer(400, { error: "Give the feed's full address, at https://" });
  }
  if (url.protocol !== "https:") return answer(400, { error: "Only https:// feeds are read" });
  if (url.username || url.password) return answer(400, { error: "A feed's address can't hold a user name or password" });
  url.hash = "";

  const key = url.href;
  const kept = memory.get(key);
  if (kept && Date.now() - kept.at < FRESH) return new Response(kept.body, { status: 200, headers });
  try {
    const [xml, from] = await download(url, get);
    const body = JSON.stringify({ url: from, ...parse(xml, from) });
    memory.delete(key);
    memory.set(key, { at: Date.now(), body });
    while (memory.size > REMEMBERED) memory.delete(memory.keys().next().value!);
    return new Response(body, { status: 200, headers });
  } catch (error) {
    const said = error instanceof Error && error.name === "TimeoutError" ? "The feed took too long to answer" : String((error as Error)?.message ?? error);
    return answer(502, { error: said.slice(0, 300) });
  }
}

function safeHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}

/** The feed's text, at most MAX_BYTES, and the address it came from after any redirects. */
async function download(start: URL, get: Get): Promise<[string, string]> {
  const signal = AbortSignal.timeout(TIMEOUT);
  let url = start;
  let response: Response;
  for (let hops = 0; ; hops++) {
    response = await get(url, signal);
    const to = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!to) break;
    await response.body?.cancel().catch(() => {});
    if (hops >= HOPS) throw new Error("The feed redirected too many times");
    url = new URL(to, url);
    if (url.protocol !== "https:") throw new Error("The feed redirected away from https://");
  }
  if (!response.ok) throw new Error(`The feed answered ${response.status}`);
  if (!response.body) return ["", url.href];
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("The feed is too big");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) (all.set(c, at), (at += c.byteLength));
  return [new TextDecoder().decode(all), url.href];
}

interface Item {
  key: string;
  title: string;
  link: string;
  published: string;
  summary: string;
}

/**
 * An RSS or Atom feed's title and newest stories (the same reading as demos/feeds/fetch.js). Only text
 * comes out. It runs in the server's own process, so every step is a single pass over the text, with no
 * pattern that rescans the rest of the feed for each unclosed tag: a feed made to be slow to read (many
 * `<item>`s or `<title>`s never closed) takes as long as a plain one of its size.
 */
export function parse(xml: string, url: string): { title: string; items: Item[] } {
  let text = String(xml);
  const root = /<(?:([\w-]{1,40}):)?(rss|feed|RDF)\b([^<>]{0,2000})>/i.exec(text);
  if (!root) throw new Error("That isn't an RSS or Atom feed");
  if (root[1] && root[2].toLowerCase() === "feed") text = text.replace(new RegExp(`<(/?)${root[1]}:`, "g"), "<$1");
  const feedBase = baseOf(root[3], url);
  const entries = entriesOf(text).map((e) => ({ body: e.body, base: baseOf(e.attributes, feedBase) }));
  const first = text.search(/<(item|entry)\b/i);
  const head = first < 0 ? text : text.slice(0, first);
  const items = entries
    .map(({ body: entry, base }): Item => {
      const title = words(tag(entry, "title")).slice(0, 300) || "(untitled)";
      const link = linkOf(entry, base);
      const published = date(tag(entry, "pubDate") || tag(entry, "published") || tag(entry, "updated") || tag(entry, "dc:date"));
      const summary = plain(tag(entry, "description") || tag(entry, "summary") || tag(entry, "content")).slice(0, 400);
      return { key: tag(entry, "guid") || tag(entry, "id") || link || title, title, link, published, summary };
    })
    .sort((a, b) => (b.published || "").localeCompare(a.published || ""))
    .slice(0, KEEP);
  return { title: words(tag(head, "title")).slice(0, 200), items };
}

/** Each <item> or <entry>: its attributes and what's inside, in one pass. One left open ends the list. */
function entriesOf(text: string): { attributes: string; body: string }[] {
  const found: { attributes: string; body: string }[] = [];
  const marks = /<(\/?)(item|entry)\b([^<>]{0,2000})>/gi;
  let open: { name: string; attributes: string; from: number } | null = null;
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
function tag(xml: string, name: string): string {
  const start = new RegExp(`<${name}\\b[^<>]{0,2000}>`, "i").exec(xml);
  if (!start) return "";
  const from = start.index + start[0].length;
  const end = new RegExp(`</${name}\\s*>`, "ig");
  end.lastIndex = from;
  const close = end.exec(xml);
  return close ? cdata(xml.slice(from, close.index)).trim() : "";
}

/** Text with each <![CDATA[…]]> unwrapped; one left open runs to the end. */
function cdata(text: string): string {
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
function strip(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let at = 0;
  for (;;) {
    const lt = html.indexOf("<", at);
    if (lt < 0) return out + html.slice(at);
    out += html.slice(at, lt) + " ";
    let end: number;
    if (lower.startsWith("<!--", lt)) {
      // `end` is the comment's last character, as it is a tag's below.
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

function baseOf(attributes: string, base: string): string {
  const given = /\bxml:base\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1];
  try {
    return given ? new URL(decode(given), base).href : base;
  } catch {
    return base;
  }
}

function linkOf(entry: string, base: string): string {
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

function words(text: string): string {
  return decode(decode(strip(String(text))))
    .replace(/\s+/g, " ")
    .trim();
}

function plain(html: string): string {
  // A summary is cut to 400 characters, so only its start is read.
  return decode(strip(decode(String(html).slice(0, 50_000))))
    .replace(/\s+/g, " ")
    .trim();
}

/** The named entities feeds use most, beyond XML's five: curly quotes, dashes, the ellipsis. */
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", sbquo: "‚", bdquo: "„", prime: "′", Prime: "″",
  hellip: "…", mdash: "—", ndash: "–", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", deg: "°",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", times: "×", divide: "÷", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶",
};

function decode(text: string): string {
  return String(text).replace(/&(#x[0-9a-f]{1,8}|#\d{1,10}|[a-z]{1,32});/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? all;
  });
}

function date(text: string): string {
  const t = Date.parse(text);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}
