// SVG and canvas in views, loaded only when a view has one (drawing-gate.ts),
// as its own file (/assets/drawing-<hash>.js). It imports nothing the host has: what
// it needs from the sanitiser and the canvas code is lent to it.
//
// copySvg copies an <svg> from a plugin's HTML into the page, keeping only what
// src/shared/svg.ts lists. The HTML was parsed in an inert <template>, so the
// SVG's elements are already in the SVG namespace, with their names in SVG's
// case (linearGradient). Anything not listed goes with its content: an SVG
// element that isn't a shape is either code (script, animate, set), a door to
// HTML (foreignObject) or a request (image, feImage). Addresses stay inside
// the view: `href` and `url()` may only name an #id, and ids are scoped to
// the plugin as in the rest of the view.

import { SVG_ATTRIBUTES, SVG_TAGS, SVG_URL_ATTRIBUTES } from "../shared/svg";
// The page's theme for canvases is part of this file too: nothing reads it until a view has a canvas.
export { canvasTheme, watchCanvasTheme } from "./canvas-theme";
import type { CanvasHost, DrawScope } from "./drawing-hooks";

const SVG_NS = "http://www.w3.org/2000/svg";

const TAGS = new Set(SVG_TAGS);
// Imports nothing the page script has, so it loads as one small file (drawing-gate.ts).
const ATTRIBUTES = new Set([...SVG_ATTRIBUTES, "id"]);
/** Elements whose text is drawn. Text anywhere else is only whitespace between shapes. */
const TEXT = new Set(["text", "tspan", "textPath", "title", "desc"]);
/** Longest attribute value kept: a long path's d= fits; a novel doesn't. */
const MAX_VALUE = 100_000;


/** The value to keep for an attribute of an SVG element, or undefined to drop it. */
function valueFor(tag: string, name: string, value: string, scope: DrawScope): string | undefined {
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
  // mask (and others) take CSS images too: image-set("https://…") loads without url(), so every image function goes (as plugin-styles.ts does).
  if (/(javascript|data|vbscript)\s*:|expression\s*\(|@import|\b(src|image-set|image|cross-fade|element|paint)\s*\(/i.test(value)) return undefined;
  return scope.scoped(name, value);
}

function allowed(name: string, globals: string[]): boolean {
  if (name.startsWith("on") || name === "slot" || name === "is" || name === "data-plugin") return false;
  return name.startsWith("aria-") || name.startsWith("data-") || ATTRIBUTES.has(name) || globals.includes(name);
}

/** A copy of `el` (an element in the SVG namespace) holding only what is allowed, or null if it isn't. */
export function copySvg(el: Element, scope: DrawScope): Element | null {
  const tag = el.localName;
  if (el.namespaceURI !== SVG_NS || !TAGS.has(tag)) return null;
  const out = document.createElementNS(SVG_NS, tag);
  for (const { name, value } of [...el.attributes]) {
    if (name === "style") {
      const style = scope.style(value);
      if (style) out.setAttribute("style", style);
      continue;
    }
    if (!allowed(name, scope.globals)) continue;
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

/** The largest canvas side, in pixels (width and height are allowed up to this). */
const CANVAS_MAX = 4096;

/** A canvas's side, in pixels, from its attribute: a whole number from 1 to CANVAS_MAX, else the default. */
function side(value: string | null, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= CANVAS_MAX ? n : fallback;
}

/**
 * A <canvas id> becomes a stand-in that placeCanvases turns live: its id is the name the plugin's worker
 * gets it by. Without a usable id there is nothing to hand the worker, so it says so instead.
 */
export function canvasStandIn(el: Element, scope: DrawScope): Element {
  const id = el.getAttribute("id") ?? "";
  if (!/^[A-Za-z][\w-]{0,63}$/.test(id)) {
    const note = document.createElement("span");
    note.className = "muted";
    note.textContent = "A canvas needs an id, such as <canvas id=\"chart\">.";
    return note;
  }
  const out = document.createElement("canvas");
  out.width = side(el.getAttribute("width"), 300);
  out.height = side(el.getAttribute("height"), 150);
  out.dataset.canvasId = id;
  if (el.hasAttribute("pointer")) out.setAttribute("data-pointer", "");
  out.id = scope.id(id);
  for (const { name, value } of [...el.attributes]) {
    if (name.startsWith("on") || name === "data-plugin" || name === "data-canvas" || name === "data-canvas-id") continue;
    if (name.startsWith("aria-") || name.startsWith("data-") || scope.globals.includes(name)) out.setAttribute(name, scope.scoped(name, value));
  }
  return out;
}


export interface CanvasSpec {
  id: string;
  width: number;
  height: number;
  pointer?: boolean;
}

/**
 * The live canvases plugins draw on from their workers: a canvas view, or a <canvas id> in an HTML view or
 * template. Each is made once per plugin instance and id, handed to the plugin's worker as an
 * OffscreenCanvas with the page's theme, and kept in `canvases` so a redraw puts the same element back
 * (main.ts swaps the stand-in for it).
 *
 * With pointer on, a tap or drag goes to the plugin as the event `canvas:pointer`, { canvas, type, x, y,
 * id, kind }: type is down, move, up or cancel; x and y are in the canvas's own pixels (its width and
 * height, whatever size the page shows it at), so the plugin needn't know the layout; id tells two fingers
 * apart; kind is mouse, pen or touch. Moves are sent only while a button or finger is down, at most once a
 * frame. The page doesn't scroll or zoom under a finger on it.
 *
 * Returns the stand-in to draw (the live canvas takes its place), or a note if the plugin can't draw here:
 * a canvas can only go to a worker this tab created (handing an OffscreenCanvas to another tab's worker
 * crashed the renderer, Chromium 153), so plugins that draw use `scope: "tab"`.
 */
export function liveCanvas(spec: CanvasSpec, { owner, tab, send, canvases, theme }: CanvasHost): HTMLElement {
  if (!owner.endsWith(`@${tab}`)) {
    const note = document.createElement("span");
    note.className = "muted";
    note.textContent = "Plugins that draw need scope: \"tab\".";
    return note;
  }
  const key = `${owner}/${spec.id}`;
  if (!canvases.has(key)) {
    const el = document.createElement("canvas");
    el.width = spec.width;
    el.height = spec.height;
    el.dataset.canvas = key;
    if (spec.pointer) pointer(el, spec, (value) => send({ t: "event", owner, action: "canvas:pointer", value, trace: `canvas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }));
    const offscreen = el.transferControlToOffscreen();
    send({ t: "canvas", owner, id: spec.id, canvas: offscreen, theme: theme() }, [offscreen]);
    canvases.set(key, el);
  }
  const placeholder = document.createElement("canvas");
  placeholder.dataset.canvas = key;
  return placeholder;
}

/** What a template's canvas may say about itself (data-action and the like too); its size, and the host's own data-canvas marks, stay as they are. */
const LABELS = /^(class|role|title|hidden|tabindex|id|aria-[\w-]+|data-(?!canvas$|canvas-id$|pointer$)[\w-]+)$/;

/**
 * Turns the canvas stand-ins in a drawn HTML view or template into live canvases' stand-ins (or notes).
 * The live canvas takes the stand-in's class, role, aria-* and the like, so the template can change them.
 */
export function placeCanvases(root: ParentNode, host: CanvasHost): void {
  for (const stand of root.querySelectorAll<HTMLCanvasElement>("canvas[data-canvas-id]")) {
    const placed = liveCanvas({ id: stand.dataset.canvasId!, width: stand.width, height: stand.height, pointer: stand.hasAttribute("data-pointer") }, host);
    const live = placed.dataset.canvas ? host.canvases.get(placed.dataset.canvas) : undefined;
    if (live) {
      for (const { name } of [...live.attributes]) if (LABELS.test(name) && !stand.hasAttribute(name)) live.removeAttribute(name);
      for (const { name, value } of [...stand.attributes]) if (LABELS.test(name) && live.getAttribute(name) !== value) live.setAttribute(name, value);
    }
    stand.replaceWith(placed);
  }
}

type Pointer = { canvas: string; type: "down" | "move" | "up" | "cancel"; x: number; y: number; id: number; kind: string };

/** Sends the taps and drags on a canvas, in its own pixels. */
function pointer(el: HTMLCanvasElement, spec: CanvasSpec, send: (value: Pointer) => void) {
  el.style.touchAction = "none";
  const down = new Set<number>();
  let moved: PointerEvent | undefined;
  let frame = 0;
  const at = (e: PointerEvent, type: Pointer["type"]): Pointer => {
    const box = el.getBoundingClientRect();
    const x = box.width ? ((e.clientX - box.left) / box.width) * spec.width : 0;
    const y = box.height ? ((e.clientY - box.top) / box.height) * spec.height : 0;
    return { canvas: spec.id, type, x: Math.round(Math.min(spec.width, Math.max(0, x))), y: Math.round(Math.min(spec.height, Math.max(0, y))), id: e.pointerId, kind: e.pointerType || "mouse" };
  };
  const flush = () => {
    frame = 0;
    if (moved) send(at(moved, "move"));
    moved = undefined;
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    down.add(e.pointerId);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    e.preventDefault();
    send(at(e, "down"));
  });
  el.addEventListener("pointermove", (e) => {
    if (!down.has(e.pointerId)) return;
    moved = e;
    frame ||= requestAnimationFrame(flush);
  });
  const end = (type: "up" | "cancel") => (e: PointerEvent) => {
    if (!down.delete(e.pointerId)) return;
    if (moved?.pointerId === e.pointerId) flush();
    send(at(e, type));
  };
  el.addEventListener("pointerup", end("up"));
  el.addEventListener("pointercancel", end("cancel"));
}
