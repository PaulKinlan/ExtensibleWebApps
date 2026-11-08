// Turns a plugin's HTML into DOM the host can trust. The HTML is parsed in
// an inert <template> (nothing loads, nothing runs), then rebuilt keeping
// only the elements and attributes listed in shared/html.ts. Anything else
// is dropped: elements that hold code or load things go with their content,
// unknown elements are unwrapped so their text survives.

import { COMPONENTS, DROPPED_WITH_CONTENT, ELEMENT_ATTRIBUTES, ELEMENTS, GLOBAL_ATTRIBUTES, INPUT_TYPES } from "../shared/html";

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
      if (!allowedAttribute(tag, name)) continue;
      if (name === "href" && !SAFE_HREF.test(value.trim()) && !isLocal(value)) continue;
      // An https image is a request: only plugins allowed on the network may make one. A file next to the template is the plugin's own.
      if (name === "src" && !(remote ? SAFE_SRC : DATA_SRC).test(value.trim())) {
        const own = tag === "img" ? ownFile(value, base) : undefined;
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
    copy(el, out, owner, remote, base);
    into.appendChild(out);
  }
}

/** A plugin's HTML as a fragment of allowed DOM. */
export function sanitize(html: string, owner: string, { remote = false, base }: { remote?: boolean; base?: string } = {}): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  const out = document.createDocumentFragment();
  copy(template.content, out, owner, remote, base);
  return out;
}
