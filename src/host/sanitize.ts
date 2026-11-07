// Turns a plugin's HTML into DOM the host can trust. The HTML is parsed in
// an inert <template> (nothing loads, nothing runs), then rebuilt keeping
// only the elements and attributes listed in shared/html.ts. Anything else
// is dropped: elements that hold code or load things go with their content,
// unknown elements are unwrapped so their text survives.

import { COMPONENTS, DROPPED_WITH_CONTENT, ELEMENT_ATTRIBUTES, ELEMENTS, GLOBAL_ATTRIBUTES, INPUT_TYPES } from "../shared/html";

const SAFE_HREF = /^(https?:|mailto:|#)/i;
const SAFE_SRC = /^(https:|data:image\/(png|jpeg|gif|webp|avif);)/i;
const DATA_SRC = /^data:image\/(png|jpeg|gif|webp|avif);/i;

/** Ids are prefixed with the owner, so one plugin's `for` can't point at another's control. */
const scoped = (owner: string, id: string) => `${owner.replace(/[^\w-]/g, "_")}--${id}`;

function allowedAttribute(tag: string, name: string): boolean {
  if (name.startsWith("on") || name === "style" || name === "class" || name === "slot" || name === "is") return false;
  if (tag in COMPONENTS) return true;
  if (name.startsWith("aria-") || name.startsWith("data-")) return true;
  return GLOBAL_ATTRIBUTES.includes(name) || (ELEMENT_ATTRIBUTES[tag] ?? []).includes(name);
}

function copy(source: Node, into: Node, owner: string, remote: boolean): void {
  for (const child of [...source.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(document.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue; // comments, processing instructions
    const el = child as Element;
    const tag = el.localName;
    if (DROPPED_WITH_CONTENT.has(tag)) continue;
    if (!(tag in ELEMENTS) && !(tag in COMPONENTS)) {
      copy(el, into, owner, remote); // unwrap: keep the text, lose the element
      continue;
    }
    const out = document.createElement(tag);
    for (const { name, value } of [...el.attributes]) {
      if (!allowedAttribute(tag, name)) continue;
      if (name === "href" && !SAFE_HREF.test(value.trim())) continue;
      // An https image is a request: only plugins allowed on the network may make one.
      if (name === "src" && !(remote ? SAFE_SRC : DATA_SRC).test(value.trim())) continue;
      if (tag === "input" && name === "type" && !INPUT_TYPES.includes(value.toLowerCase())) continue;
      out.setAttribute(name, name === "id" || name === "for" ? scoped(owner, value) : value);
    }
    if (tag === "a") {
      out.setAttribute("target", "_blank");
      out.setAttribute("rel", "noopener noreferrer");
    }
    if (tag === "img") out.setAttribute("referrerpolicy", "no-referrer");
    copy(el, out, owner, remote);
    into.appendChild(out);
  }
}

/** A plugin's HTML as a fragment of allowed DOM. */
export function sanitize(html: string, owner: string, { remote = false } = {}): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  const out = document.createDocumentFragment();
  copy(template.content, out, owner, remote);
  return out;
}
