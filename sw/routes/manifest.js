// Makes every app installable. An app's folder may hold its own
// manifest.webmanifest (demos/reading-list/ does, to be a share target); an
// app that has none gets one made from its page here: its <title>, its
// <meta name="description">, "theme-color" and "short-name" (the name under
// its icon, when the title is too long for one), and its <link rel="icon">,
// opening at the app's folder; and <meta name="file-handlers"> and
// <meta name="share-target"> make it a place to open files or share to
// (../launch-meta.js). The host links each app page to
// manifest.webmanifest in its folder (src/host/install.ts), so the browser
// can offer to install any app, including one made in the browser
// (/apps/<name>/, read from the data folder as sw/routes/made.js does).
//
// Installed or not, an app opens offline once it has been opened: sw.js
// keeps what it served.

import { launchManifest } from "../launch-meta.js";
import { APP_NAME } from "../made-page.js";

/** Used when a page names no icon of its own: the platform's, in public/. */
const ICON = "/app-icon.svg";

/** A made app's page, from the data folder, or undefined. @param {string} app */
async function madePage(app) {
  try {
    let folder = await navigator.storage.getDirectory();
    for (const part of ["made", "apps", app]) folder = await folder.getDirectoryHandle(part);
    return await (await (await folder.getFileHandle("app.html")).getFile()).text();
  } catch {
    return undefined;
  }
}

/** The page of the app in a folder, if there is one: its app.html, or for the site's own front page, index.html. @param {string} folder @param {URL} url @param {{ fetch(r: Request): Promise<Response> }} env */
async function pageIn(folder, url, env) {
  const made = /^\/apps\/([^/]+)\/$/.exec(folder)?.[1];
  if (made) return APP_NAME.test(made) ? madePage(made) : undefined;
  for (const name of folder === "/" ? ["index.html"] : ["app.html", "index.html"]) {
    const page = await env.fetch(new Request(new URL(`${folder}${name}`, url))).catch(() => undefined);
    if (!page?.ok || !(page.headers.get("Content-Type") ?? "").includes("text/html")) continue;
    const html = await page.text();
    if (/<script\b[^>]*\bsrc=["']?\/platform\/host\.js/i.test(html)) return html;
  }
  return undefined;
}

/** The text of an element or attribute in a page, with entities for <, >, & and quotes read back. @param {string | undefined} s */
const plain = (s) => (s ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** The content of a <meta name="…"> in a page. @param {string} html @param {string} name */
function meta(html, name) {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (new RegExp(`\\bname=["']?${name}["'\\s>]`, "i").test(m[0])) return plain(/\bcontent=(?:"([^"]*)"|'([^']*)')/i.exec(m[0])?.slice(1).find((v) => v !== undefined));
  }
  return "";
}

/** True if a page has a <meta name="…">. @param {string} html @param {string} name */
const hasMeta = (html, name) => [...html.matchAll(/<meta\b[^>]*>/gi)].some((m) => new RegExp(`\\bname=["']?${name}["'\\s>]`, "i").test(m[0]));

/** A page's icon address for its manifest: resolved against the app's folder, keeping its query and fragment; an address on another site as it is. @param {string} href @param {string} folder */
function iconSrc(href, folder) {
  const base = new URL(folder, "https://app.invalid");
  const to = new URL(href, base);
  return to.origin === base.origin ? `${to.pathname}${to.search}${to.hash}` : to.href;
}

/**
 * The manifest of the app whose page is `html`, at `folder`.
 * @param {string} html @param {string} folder
 */
export function manifestFor(html, folder) {
  const title = plain(/<title\b[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]) || folder.split("/").filter(Boolean).pop() || "App";
  // An app's title is often "Reading list · Extensible web apps": the part before the dot names it.
  const name = title.split(/\s+[·|—–-]\s+/)[0] || title;
  const icon = /<link\b(?=[^>]*\brel=["']?icon\b)[^>]*\bhref=(?:"([^"]*)"|'([^']*)')/i.exec(html)?.slice(1).find((v) => v !== undefined);
  const theme = meta(html, "theme-color");
  const description = meta(html, "description");
  // The name under an installed app's icon: the page's own choice, or else the name if it is short, or its first word.
  const short = meta(html, "short-name");
  return {
    name,
    short_name: short || (name.length > 12 ? name.split(" ")[0] : name),
    ...(description ? { description } : {}),
    id: folder,
    start_url: folder,
    scope: folder,
    display: "standalone",
    ...(/^#[0-9a-f]{3,8}$/i.test(theme) ? { theme_color: theme } : {}),
    icons: [icon ? { src: iconSrc(plain(icon), folder), sizes: "any", purpose: "any" } : { src: ICON, sizes: "any", type: "image/svg+xml", purpose: "any" }],
    // <meta name="file-handlers"> and <meta name="share-target"> (../launch-meta.js). A line it can't read adds nothing.
    ...launchManifest((n) => (hasMeta(html, n) ? meta(html, n) : undefined)).manifest,
  };
}

export default {
  name: "manifest",
  /** @param {Request} request @param {URL} url @param {{ fetch(r: Request): Promise<Response> }} env */
  async handle(request, url, env) {
    if (request.method !== "GET" || !url.pathname.endsWith("/manifest.webmanifest")) return undefined;
    const folder = url.pathname.slice(0, -"manifest.webmanifest".length);
    // In a space (/s/<space>/demos/habits/) the app's files are its own, outside the space (sw/routes/spaces.js); it installs and opens in the space.
    const outside = folder.replace(/^\/s\/[a-z0-9][a-z0-9-]{0,62}(?=\/)/, "");
    // An app's own manifest wins (but not a made app's folder, which holds no manifest). It is read from the app's
    // folder and served at the address asked for, so its relative addresses (start_url, share_target,
    // file_handlers) stay in the space.
    if (!/^\/apps\//.test(outside)) {
      const own = await env.fetch(new Request(new URL(`${outside}manifest.webmanifest`, url))).catch(() => undefined);
      if (own?.ok && !(own.headers.get("Content-Type") ?? "").includes("text/html")) {
        if (outside === folder) return own;
        return new Response(await own.text(), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" } });
      }
    }
    const html = await pageIn(outside, url, env);
    if (html === undefined) return undefined;
    return new Response(JSON.stringify(manifestFor(html, folder), null, 2), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" } });
  },
};
