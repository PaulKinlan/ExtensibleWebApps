// @ts-check
// The rules for the app.html of an app made in the browser (std/maker/): what
// the page may hold, so a page a model wrote can lay out slots and link
// plugins, but can never run code of its own. The kernel checks a page with
// these before it saves it (std/maker/module.ts), and the service worker
// checks it again before it serves it (sw/routes/made.js), which also sends a
// policy that runs no script but the platform's own files.
//
// An app's code lives in its plugins, each in a worker with only the
// permissions its manifest lists. The page is layout: slots, headings, plain
// text and links, a <style>, and <link rel="plugin"> lines.

import { LAUNCH_META, launchManifest } from "./launch-meta.js";

/** The one script a made app's page may load. */
export const HOST_SCRIPT = '<script type="module" src="/platform/host.js"></script>';

/** Elements a made app's page may not hold at all. */
const BANNED = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "portal", "noscript", "svg", "math", "fencedframe"]);

/** The kinds of <link> it may hold, and whether each may point to another site. */
const LINKS = { plugin: false, agent: false, "plugin-sample": false, stylesheet: false, icon: true, manifest: false };

/** URL attributes, whose value must be a relative address, a path on this site, https:, mailto: or #. */
const URLS = new Set(["href", "src", "action", "formaction", "poster", "cite", "data", "background", "xlink:href"]);

const lineOf = (/** @type {string} */ text, /** @type {number} */ index) => text.slice(0, index).split("\n").length;

/**
 * Every tag in the page, with its attributes parsed as a browser reads them (double, single or no quotes).
 * Comments are skipped, keeping line numbers.
 * @param {string} html
 */
export function tags(html) {
  const blanked = html.replace(/<!--[^]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, " "));
  /** @type {{ name: string; closing: boolean; attributes: Record<string, string>; names: string[]; line: number; index: number; end: number }[]} */
  const out = [];
  for (const m of blanked.matchAll(/<(\/?)([a-zA-Z][^\s/>]*)((?:\s*[^\s=>"'/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']*))?|\s*\/)*)\s*>/g)) {
    /** @type {Record<string, string>} */
    const attributes = Object.create(null);
    const names = [];
    for (const a of m[3].matchAll(/([^\s=>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']*)))?/g)) {
      const name = a[1].toLowerCase();
      names.push(name);
      // A browser keeps an attribute's first value and drops the rest: so does this, and pageProblems refuses the repeat.
      if (!(name in attributes)) attributes[name] = a[2] ?? a[3] ?? a[4] ?? "";
    }
    out.push({ name: m[2].toLowerCase(), closing: m[1] === "/", attributes, names, line: lineOf(blanked, m.index), index: m.index, end: m.index + m[0].length });
  }
  return { tags: out, blanked };
}

/** True if a URL is a relative address, a path on this site, https:, mailto: or a #fragment. @param {string} value */
function safeUrl(value) {
  // Browsers drop tabs and newlines and trim spaces before reading a URL's scheme.
  const v = value.replace(/[\u0000- ]/g, "").toLowerCase();
  if (v.startsWith("//") || v.startsWith("/\\") || v.startsWith("\\")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v)?.[1];
  return !scheme || scheme === "https" || scheme === "http" || scheme === "mailto";
}

/** True if a URL stays on this site: relative, or a path from its root. @param {string} value */
const onThisSite = (value) => safeUrl(value) && !/^[a-z][a-z0-9+.-]*:/i.test(value.trim());

/**
 * What's wrong with a made app's page, in words a model can act on. An empty list means it may be saved and served.
 * @param {string} html
 * @returns {{ line: number; message: string }[]}
 */
export function pageProblems(html) {
  /** @type {{ line: number; message: string }[]} */
  const problems = [];
  if (typeof html !== "string") return [{ line: 1, message: "app.html must be text" }];
  if (html.length > 100_000) problems.push({ line: 1, message: "app.html is limited to 100000 characters" });
  const { tags: all, blanked } = tags(html);
  let host = 0;
  for (const tag of all) {
    if (tag.closing) continue;
    const { name, attributes, line } = tag;
    const repeated = tag.names.filter((n, i) => tag.names.indexOf(n) !== i);
    if (repeated.length) {
      problems.push({ line, message: `<${name}> has ${[...new Set(repeated)].join(", ")} more than once: give each attribute once` });
      continue;
    }
    if (name === "script") {
      const isHost = attributes.src === "/platform/host.js" && attributes.type === "module" && tag.names.every((n) => n === "src" || n === "type" || n === "blocking");
      // Nothing between the tags: a script with a src runs only that file, but say so plainly.
      const close = blanked.slice(tag.end).search(/<\/script\s*>/i);
      if (isHost && close >= 0 && !blanked.slice(tag.end, tag.end + close).trim()) {
        host++;
        continue;
      }
      problems.push({ line, message: `The only script a page may have is ${HOST_SCRIPT}. Put code in a plugin: <link rel="plugin" href="x.js">` });
      continue;
    }
    if (BANNED.has(name)) {
      problems.push({ line, message: `<${name}> isn't allowed in an app's page. Lay out slots in plain HTML, and draw with plugins` });
      continue;
    }
    if (name === "meta" && ("http-equiv" in attributes || ("name" in attributes && !["viewport", "description", "color-scheme", "theme-color", "short-name", ...LAUNCH_META].includes(attributes.name.toLowerCase())))) {
      problems.push({ line, message: '<meta> may only be charset, or name="viewport", "description", "color-scheme", "theme-color", "short-name", "file-handlers" or "share-target"' });
    } else if (name === "meta" && LAUNCH_META.includes((attributes.name ?? "").toLowerCase())) {
      // The app's file handlers and share target (launch-meta.js): a line the manifest can't use is a mistake now, not a silent no-op later.
      const which = attributes.name.toLowerCase();
      for (const message of launchManifest((n) => (n === which ? (attributes.content ?? "") : undefined)).problems) problems.push({ line, message });
    }
    for (const attribute of tag.names) {
      const value = attributes[attribute];
      if (attribute.startsWith("on")) problems.push({ line, message: `${attribute}= isn't allowed: a page runs no code. Use data-action in a plugin's view` });
      else if (attribute === "srcdoc" || attribute === "srcset" || attribute === "is") problems.push({ line, message: `${attribute}= isn't allowed in an app's page` });
      else if (URLS.has(attribute) && !safeUrl(value)) problems.push({ line, message: `${attribute}="${value}" isn't allowed: use a relative address, a path on this site, https: or mailto:` });
      else if (attribute === "style" && /expression\s*\(|url\s*\(|@import|javascript:/i.test(value)) problems.push({ line, message: "style= may not load anything: put looks in the page's <style>" });
    }
    if (name === "link") {
      const rels = (attributes.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const kind = rels.find((r) => r in LINKS);
      if (!kind || rels.length !== 1) {
        problems.push({ line, message: `<link rel="${attributes.rel ?? ""}"> isn't allowed. A page may link: ${Object.keys(LINKS).join(", ")}` });
        continue;
      }
      const href = attributes.href ?? "";
      if (!href) problems.push({ line, message: `<link rel="${kind}"> needs an href` });
      else if (!LINKS[/** @type {keyof typeof LINKS} */ (kind)] && !onThisSite(href)) problems.push({ line, message: `<link rel="${kind}" href="${href}">: it must be on this site, such as library.js or /std/board.js` });
    }
    if (name === "style" || name === "title" || name === "textarea") continue;
  }
  // CSS can't run code, but it can fetch: keep a page's <style> to looks, with no imports or outside addresses.
  for (const m of html.matchAll(/<style\b[^>]*>([^]*?)<\/style\s*>/gi)) {
    if (/@import|expression\s*\(|javascript:|url\s*\(\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(m[1])) problems.push({ line: lineOf(html, m.index), message: "A <style> may not @import or load from another site: keep it to looks" });
  }
  if (host === 0) problems.push({ line: 1, message: `app.html doesn't load the platform: put ${HOST_SCRIPT} in its <head>` });
  if (host > 1) problems.push({ line: 1, message: "app.html loads the platform more than once" });
  return problems;
}

/**
 * The page's <link rel="plugin"> and <link rel="agent"> lines, and its slots.
 * @param {string} html
 */
export function pageParts(html) {
  const { tags: all } = tags(html);
  const open = all.filter((t) => !t.closing);
  const links = open.filter((t) => t.name === "link").map((t) => ({ rel: (t.attributes.rel ?? "").toLowerCase().trim(), href: t.attributes.href ?? "", line: t.line }));
  return {
    plugins: links.filter((l) => l.rel === "plugin" && l.href),
    agents: links.filter((l) => l.rel === "agent" && l.href),
    slots: new Set(open.filter((t) => t.name === "slot" && t.attributes.name).map((t) => t.attributes.name)),
    title: /<title\b[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "",
  };
}

/** The address a made app is served at, from its name. @param {string} name */
export const appUrl = (name) => `/apps/${name}/`;

/** A made app's name: lowercase letters, digits and dashes, as a plugin's id is. */
export const APP_NAME = /^[a-z][a-z0-9-]{0,47}$/;

/** A file a made app may hold: app.html, plugins (.js), their templates (.html), styles (.css) and agents (.agent.md). */
export const FILE_NAME = /^(?:app\.html|[a-z0-9][a-z0-9-]{0,63}\.(?:js|html|css|agent\.md))$/;

/**
 * The policy a made app's page is served with: scripts only from this site (the platform's own files; the
 * page rules allow no other script tag), workers from blob: (plugins' sandboxes), and no plugins or frames
 * of other sites. Inline scripts and javascript: URLs never run, and markup reaches the page only through
 * the host's Trusted Types policies, as on every page of the site (public/_headers).
 */
export const PAGE_CSP = "script-src 'self' blob: 'inline-speculation-rules'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'; require-trusted-types-for 'script'; trusted-types platform default mermaid dompurify";

/** The device features a made app's page may use: the same as every page of the site's (public/_headers; tests/checks/page-policy.mjs keeps them equal). */
export const PERMISSIONS_POLICY = "accelerometer=(), autoplay=(self), bluetooth=(), camera=(), clipboard-write=(self), display-capture=(), fullscreen=(self), gamepad=(self), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(self), midi=(), payment=(), publickey-credentials-create=(self), publickey-credentials-get=(self), screen-wake-lock=(self), serial=(), usb=(), web-share=(self), xr-spatial-tracking=()";
