// Turns a plugin's HTML into DOM the host can trust. The HTML is parsed in
// an inert <template> (nothing loads, nothing runs), then rebuilt keeping
// only the elements and attributes listed in shared/html.ts. Anything else
// is dropped: elements that hold code or load things go with their content,
// unknown elements are unwrapped so their text survives.

import { COMPONENTS, DROPPED_WITH_CONTENT, ELEMENT_ATTRIBUTES, ELEMENTS, GLOBAL_ATTRIBUTES, INPUT_TYPES } from "../shared/html";
import { html as trusted } from "./trusted";

const SAFE_HREF = /^(https?:|mailto:|#)/i;
const SAFE_SRC = /^(https:|data:image\/(png|jpeg|gif|webp|avif);)/i;
const DATA_SRC = /^data:image\/(png|jpeg|gif|webp|avif);/i;

/** A link on this site, such as another screen of the app (`book/42`, `./`): it opens in the same tab. */
const isLocal = (href: string) => !/^([a-z][\w+.-]*:|\/\/|\\|#)/i.test(href.trim());

/** Ids are prefixed with the owner, so one plugin's `for` can't point at another's control. */
const scoped = (owner: string, id: string) => `${owner.replace(/[^\w-]/g, "_")}--${id}`;

/** ARIA attributes that hold id references, scoped the same way as ids. */
const ID_REFERENCES = new Set(["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-activedescendant", "aria-details", "aria-errormessage", "aria-flowto"]);

function scopedValue(owner: string, name: string, value: string): string {
  if (name === "id" || name === "for") return scoped(owner, value);
  if (ID_REFERENCES.has(name)) return value.split(/\s+/).filter(Boolean).map((id) => scoped(owner, id)).join(" ");
  if (name === "href" && value.trim().startsWith("#") && value.trim().length > 1) return `#${scoped(owner, value.trim().slice(1))}`;
  return value;
}

/** A custom property's name, and a number with an optional unit: all a `style` attribute may set. */
// Custom property names are case-sensitive (--Pct and --pct differ), so the name is kept as written.
const PROPERTY = /^--[a-z][a-z0-9-]{0,31}$/i;
const NUMBER = /^-?(\d{1,6}(\.\d{1,4})?|\.\d{1,4})(px|rem|em|ch|%|vh|vw|deg|turn|s|ms|fr)?$/;
const MAX_PROPERTIES = 8;

/**
 * A `style` attribute, rebuilt from the custom properties it sets to numbers (`--pct: 40`,
 * `--w: 12.5rem`), so data can size things (`width: calc(var(--pct) * 1%)` in the plugin's CSS).
 * Nothing else is kept: no other property, nothing that loads, nothing that could break out.
 * Undefined when nothing is left.
 */
export function customProperties(value: string): string | undefined {
  const kept: string[] = [];
  for (const declaration of value.split(";")) {
    if (!declaration.trim()) continue;
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim();
    const number = declaration.slice(colon + 1).trim();
    if (PROPERTY.test(name) && NUMBER.test(number) && kept.length < MAX_PROPERTIES) kept.push(`${name}: ${number}`);
  }
  return kept.length ? kept.join("; ") : undefined;
}

function allowedAttribute(tag: string, name: string): boolean {
  // data-plugin marks which plugin's stylesheet applies to a view, so only the host sets it.
  if (name.startsWith("on") || name === "style" || name === "slot" || name === "is" || name === "data-plugin") return false;
  if (tag in COMPONENTS) return true;
  if (name.startsWith("aria-") || name.startsWith("data-")) return true;
  return GLOBAL_ATTRIBUTES.includes(name) || (ELEMENT_ATTRIBUTES[tag] ?? []).includes(name);
}

/**
 * An image next to a template file (`<img src="tram.png">` in countdown.html) is the plugin's own file,
 * so it may load without the network permission. Anything that climbs out of the template's folder or
 * leaves the site doesn't count.
 */
function ownFile(value: string, base: string | undefined): string | undefined {
  if (!base || /^[a-z][\w+.-]*:/i.test(value.trim()) || value.trim().startsWith("//")) return undefined;
  const url = new URL(value.trim(), base);
  const folder = new URL(".", base);
  return url.origin === folder.origin && url.pathname.startsWith(folder.pathname) && !url.search ? url.href : undefined;
}

function copy(source: Node, into: Node, owner: string, remote: boolean, base?: string): void {
  for (const child of [...source.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(document.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue; // comments, processing instructions
    const el = child as Element;
    const tag = el.localName;
    if (DROPPED_WITH_CONTENT.has(tag)) continue;
    // A slot is a room the plugin opens to others, so its name must be the plugin's own: `cookbook.recipe.actions`.
    if (tag === "slot" && !(el.getAttribute("name") ?? "").startsWith(`${owner.split("@")[0]}.`)) {
      copy(el, into, owner, remote, base);
      continue;
    }
    if (!(tag in ELEMENTS) && !(tag in COMPONENTS)) {
      copy(el, into, owner, remote, base); // unwrap: keep the text, lose the element
      continue;
    }
    const out = document.createElement(tag);
    for (const { name, value } of [...el.attributes]) {
      if (name === "style") {
        const style = customProperties(value);
        if (style) out.setAttribute("style", style);
        continue;
      }
      if (!allowedAttribute(tag, name)) continue;
      if (name === "href" && !SAFE_HREF.test(value.trim()) && !isLocal(value)) continue;
      // An https image is a request: only plugins allowed on the network may make one. A file next to the template is the plugin's own.
      if (name === "src" && !(remote ? SAFE_SRC : DATA_SRC).test(value.trim())) {
        // So is a Markdown file a ui-markdown draws: it is fetched from this site and shown as text.
        const own = tag === "img" || tag === "ui-markdown" ? ownFile(value, base) : undefined;
        if (own) out.setAttribute("src", own);
        continue;
      }
      if (tag === "input" && name === "type" && !INPUT_TYPES.includes(value.toLowerCase())) continue;
      out.setAttribute(name, scopedValue(owner, name, value));
    }
    if (tag === "a" && !isLocal(el.getAttribute("href") ?? "")) {
      out.setAttribute("target", "_blank");
      out.setAttribute("rel", "noopener noreferrer");
    }
    if (tag === "img") out.setAttribute("referrerpolicy", "no-referrer");
    // Something a view says can be picked up (drag.ts). Images and links are draggable already, which data-drag doesn't change.
    if (out.hasAttribute("data-drag")) out.setAttribute("draggable", "true");
    copy(el, out, owner, remote, base);
    into.appendChild(out);
  }
}

let inert: Document | undefined;

/** A plugin's HTML as a fragment of allowed DOM. */
export function sanitize(html: string, owner: string, { remote = false, base }: { remote?: boolean; base?: string } = {}): DocumentFragment {
  // Parsed in a document of its own, with no window: an onclick= in the plugin's HTML never becomes a
  // handler on the page, so the page's policy (no inline handlers) isn't even asked before it is dropped.
  const template = (inert ??= document.implementation.createHTMLDocument("")).createElement("template");
  template.innerHTML = trusted(html);
  const out = document.createDocumentFragment();
  copy(template.content, out, owner, remote, base);
  return out;
}
