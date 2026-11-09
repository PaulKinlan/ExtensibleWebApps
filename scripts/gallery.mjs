// The demo gallery (demos/index.html) is built from the apps themselves: each
// demos/<name>/app.html says where it goes and what its card says, in its head:
//
//   <meta name="gallery" content="showcase">            the section: a <ul data-gallery="showcase"> in demos/index.html
//   <meta name="gallery-about" content="What it is.">   the card's text
//   <meta name="gallery-shows" content="slots, review."> what of the platform it shows
//   <meta name="gallery-title" content="Trip">           optional: the card's name, if not the page's <title>
//
// So adding a demo means adding its folder, not editing a shared list. Cards in
// a section are sorted by name. An app with no gallery meta, or one naming a
// section the page doesn't have, is an error: it fails, it doesn't go missing.
//
// demos/index.html is committed with its lists empty: the site fills them as it serves and builds the page
// (scripts/generated.mjs), so two pull requests that each add a demo never conflict over the page.
//
//   npm run gallery    checks every demo has its card, and says how many there are (it writes nothing)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../demos/", import.meta.url);
const PAGE = new URL("index.html", ROOT);
const LIST = /(<ul class="apps" data-gallery="([a-z-]+)">)[\s\S]*?(\n\s*<\/ul>)/g;

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A <meta name> in the page's head, or undefined. */
function meta(html, name) {
  const tag = html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"\\s*/?>`));
  return tag ? unescape(tag[1]) : undefined;
}

/** Every app's card, as the app says it: an error for any app that doesn't. */
export function cards() {
  const found = [];
  for (const entry of readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = new URL(`${entry.name}/app.html`, ROOT);
    if (!existsSync(file)) continue;
    const html = readFileSync(file, "utf8");
    const where = `demos/${entry.name}/app.html`;
    const section = meta(html, "gallery");
    const about = meta(html, "gallery-about");
    const shows = meta(html, "gallery-shows");
    const title = meta(html, "gallery-title") ?? unescape(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "").trim();
    if (!section || !about || !shows) throw new Error(`${where} needs <meta name="gallery">, <meta name="gallery-about"> and <meta name="gallery-shows"> for the demo gallery (scripts/gallery.mjs)`);
    if (!title) throw new Error(`${where} needs a <title> (or <meta name="gallery-title">) for its card`);
    found.push({ name: entry.name, section, title, about, shows });
  }
  return found;
}

/** demos/index.html with each section's list rewritten from the apps. */
export function render(page = readFileSync(PAGE, "utf8")) {
  const all = cards();
  const sections = new Set([...page.matchAll(LIST)].map((m) => m[2]));
  for (const card of all) if (!sections.has(card.section)) throw new Error(`demos/${card.name}/app.html: there's no section "${card.section}" in demos/index.html (it has ${[...sections].join(", ")})`);
  return page.replace(LIST, (_, open, section, close) => {
    const indent = close.match(/\n(\s*)/)[1];
    const items = all
      .filter((c) => c.section === section)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((c) => `\n${indent}  <li><a href="/demos/${c.name}/app.html">${escape(c.title)}</a><p>${escape(c.about)}</p><p class="shows">Shows: ${escape(c.shows)}</p></li>`);
    return `${open}${items.join("")}${close}`;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  render();
  console.log(`The demo gallery has ${cards().length} apps. The site fills demos/index.html with them as it serves and builds it.`);
}
