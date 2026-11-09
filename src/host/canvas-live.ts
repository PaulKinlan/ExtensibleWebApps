// The live canvases plugins draw on from their workers: a canvas view
// (views/canvas.ts), or a <canvas id> in an HTML view or template
// (sanitize.ts keeps it as a stand-in; placeCanvases below makes it live).
// Each is made once per plugin instance and id, handed to the plugin's worker
// as an OffscreenCanvas, and kept in `canvases` so a redraw puts the same
// element back (main.ts swaps the stand-in for it).
//
// With pointer on, a tap or drag goes to the plugin as the event
// `canvas:pointer`, { canvas, type, x, y, id, kind }: type is down, move, up
// or cancel; x and y are in the canvas's own pixels (its width and height,
// whatever size the page shows it at), so the plugin needn't know the
// layout; id tells two fingers apart; kind is mouse, pen or touch. Moves are
// sent only while a button or finger is down, at most once a frame. The
// page doesn't scroll or zoom under a finger on it.

import { canvasTheme } from "./canvas-theme";
import type { ViewHost } from "./views/index";

export interface CanvasSpec {
  id: string;
  width: number;
  height: number;
  pointer?: boolean;
}

/** False, with a note to show instead, when the plugin can't draw in this tab. */
export function canDraw(owner: string, tab: string): boolean {
  // A canvas can only go to a worker this tab created: handing an
  // OffscreenCanvas to another tab's worker crashed the renderer
  // (Chromium 153). Plugins that draw use `scope: "tab"`.
  return owner.endsWith(`@${tab}`);
}

export function needsTabNote(): HTMLElement {
  const note = document.createElement("span");
  note.className = "muted";
  note.textContent = "Plugins that draw need scope: \"tab\".";
  return note;
}

/** Makes the live canvas for `spec` if there isn't one yet, and returns its key (`owner/id`). */
export function liveCanvas(spec: CanvasSpec, { owner, send, canvases }: Pick<ViewHost, "owner" | "send" | "canvases">): string {
  const key = `${owner}/${spec.id}`;
  if (!canvases.has(key)) {
    const el = document.createElement("canvas");
    el.width = spec.width;
    el.height = spec.height;
    el.dataset.canvas = key;
    if (spec.pointer) pointer(el, spec, (value) => send({ t: "event", owner, action: "canvas:pointer", value, trace: `canvas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }));
    const offscreen = el.transferControlToOffscreen();
    send({ t: "canvas", owner, id: spec.id, canvas: offscreen, theme: canvasTheme() }, [offscreen]);
    canvases.set(key, el);
  }
  return key;
}

/** What a template's canvas may say about itself; its size and the worker's drawing stay the worker's. */
const LABELS = /^(class|role|title|hidden|tabindex|id|aria-[\w-]+)$/;

/**
 * Turns the <canvas data-canvas-id> stand-ins the sanitiser left in a view into stand-ins for live
 * canvases (the live one takes its place once the view is drawn), or a note if the plugin can't draw here.
 * The live canvas takes the stand-in's class, role, aria-* and the like, so the template can change them.
 */
export function placeCanvases(root: ParentNode, host: Pick<ViewHost, "owner" | "tab" | "send" | "canvases">): void {
  for (const stand of root.querySelectorAll<HTMLCanvasElement>("canvas[data-canvas-id]")) {
    if (!canDraw(host.owner, host.tab)) {
      stand.replaceWith(needsTabNote());
      continue;
    }
    const spec = { id: stand.dataset.canvasId!, width: stand.width, height: stand.height, pointer: stand.hasAttribute("data-pointer") };
    const key = liveCanvas(spec, host);
    const live = host.canvases.get(key)!;
    for (const { name } of [...live.attributes]) if (LABELS.test(name) && !stand.hasAttribute(name)) live.removeAttribute(name);
    for (const { name, value } of [...stand.attributes]) if (LABELS.test(name) && live.getAttribute(name) !== value) live.setAttribute(name, value);
    const placeholder = document.createElement("canvas");
    placeholder.dataset.canvas = key;
    stand.replaceWith(placeholder);
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
