// Copies an <svg> from a plugin's HTML into the page, keeping only what
// src/shared/svg.ts lists. The HTML was parsed in an inert <template>, so the
// SVG's elements are already in the SVG namespace, with their names in SVG's
// case (linearGradient). Anything not listed goes with its content: an SVG
// element that isn't a shape is either code (script, animate, set), a door to
// HTML (foreignObject) or a request (image, feImage). Addresses stay inside
// the view: `href` and `url()` may only name an #id, and ids are scoped to
// the plugin as in the rest of the view.

import { GLOBAL_ATTRIBUTES } from "../shared/html";
import { SVG_ATTRIBUTES, SVG_TAGS, SVG_URL_ATTRIBUTES } from "../shared/svg";

export const SVG_NS = "http://www.w3.org/2000/svg";

const TAGS = new Set(SVG_TAGS);
const ATTRIBUTES = new Set([...SVG_ATTRIBUTES, ...GLOBAL_ATTRIBUTES, "id"]);
/** Elements whose text is drawn. Text anywhere else is only whitespace between shapes. */
const TEXT = new Set(["text", "tspan", "textPath", "title", "desc"]);
/** Longest attribute value kept: a long path's d= fits; a novel doesn't. */
const MAX_VALUE = 100_000;

export interface SvgScope {
  /** Rewrites an id, or an attribute holding ids, to the plugin's own (as sanitize.ts does for HTML). */
  scoped(name: string, value: string): string;
  /** The custom properties a style= may set, or undefined. */
  style(value: string): string | undefined;
  /** The plugin's own id (`cookbook`), for `#cookbook--x` ids. */
  id(value: string): string;
}

/** The value to keep for an attribute of an SVG element, or undefined to drop it. */
function valueFor(tag: string, name: string, value: string, scope: SvgScope): string | undefined {
  if (value.length > MAX_VALUE) return undefined;
  // A backslash could spell url( or javascript: as a CSS escape; nothing on the list needs one.
  if (/\\/.test(value)) return undefined;
  if (name === "href") {
    const m = /^\s*#([\w-]{1,64})\s*$/.exec(value);
    return (tag === "use" || tag === "textPath") && m ? `#${scope.id(m[1])}` : undefined;
  }
  if (/url\s*\(/i.test(value)) {
    const m = /^\s*url\(\s*#([\w-]{1,64})\s*\)\s*$/i.exec(value);
    return SVG_URL_ATTRIBUTES.has(name) && m ? `url(#${scope.id(m[1])})` : undefined;
  }
  if (/(javascript|data|vbscript)\s*:|expression\s*\(|@import/i.test(value)) return undefined;
  return scope.scoped(name, value);
}

function allowed(name: string): boolean {
  if (name.startsWith("on") || name === "slot" || name === "is" || name === "data-plugin") return false;
  return name.startsWith("aria-") || name.startsWith("data-") || ATTRIBUTES.has(name);
}

/** A copy of `el` (an element in the SVG namespace) holding only what is allowed, or null if it isn't. */
export function copySvg(el: Element, scope: SvgScope): Element | null {
  const tag = el.localName;
  if (el.namespaceURI !== SVG_NS || !TAGS.has(tag)) return null;
  const out = document.createElementNS(SVG_NS, tag);
  for (const { name, value } of [...el.attributes]) {
    if (name === "style") {
      const style = scope.style(value);
      if (style) out.setAttribute("style", style);
      continue;
    }
    if (!allowed(name)) continue;
    const kept = valueFor(tag, name, value, scope);
    if (kept !== undefined) out.setAttribute(name, kept);
  }
  // An <svg> that is only a picture is left out of the tab order, as browsers differ on it.
  if (tag === "svg" && !out.hasAttribute("focusable")) out.setAttribute("focusable", "false");
  for (const child of [...el.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (TEXT.has(tag) || !(child.textContent ?? "").trim()) out.appendChild(document.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const copy = copySvg(child as Element, scope);
    if (copy) out.appendChild(copy);
  }
  return out;
}
