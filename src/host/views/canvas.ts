// The "canvas" view: a canvas a plugin draws on from its worker, through an
// OffscreenCanvas. It goes with the page's theme (../canvas-theme.ts), since a
// worker can't read CSS.
//
// With `pointer: true`, a tap or drag on it goes to the plugin as the event
// `canvas:pointer`, { canvas, type, x, y, id, kind }: type is down, move, up
// or cancel; x and y are in the canvas's own pixels (its width and height,
// whatever size the page shows it at), so the plugin needn't know the
// layout; id tells two fingers apart; kind is mouse, pen or touch. Moves are
// sent only while a button or finger is down, at most once a frame. The
// page doesn't scroll or zoom under a finger on it.

import { canvasTheme } from "../canvas-theme";
import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"canvas">, { owner, tab, send, canvases }: ViewHost): HTMLElement => {
  // A canvas can only go to a worker this tab created: handing an
  // OffscreenCanvas to another tab's worker crashed the renderer
  // (Chromium 153). Plugins that draw use `scope: "tab"`.
  if (!owner.endsWith(`@${tab}`)) {
    const note = document.createElement("span");
    note.className = "muted";
    note.textContent = "Plugins that draw need scope: \"tab\".";
    return note;
  }
  const key = `${owner}/${view.id}`;
  if (!canvases.has(key)) {
    const el = document.createElement("canvas");
    el.width = view.width;
    el.height = view.height;
    el.dataset.canvas = key;
    if (view.pointer) pointer(el, view, (value) => send({ t: "event", owner, action: "canvas:pointer", value, trace: `canvas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }));
    const offscreen = el.transferControlToOffscreen();
    send({ t: "canvas", owner, id: view.id, canvas: offscreen, theme: canvasTheme() }, [offscreen]);
    canvases.set(key, el);
  }
  // A stand-in; the live canvas takes its place once the view is drawn.
  const placeholder = document.createElement("canvas");
  placeholder.dataset.canvas = key;
  return placeholder;
};

type Pointer = { canvas: string; type: "down" | "move" | "up" | "cancel"; x: number; y: number; id: number; kind: string };

/** Sends the taps and drags on a canvas, in its own pixels. */
function pointer(el: HTMLCanvasElement, view: ViewOf<"canvas">, send: (value: Pointer) => void) {
  el.style.touchAction = "none";
  const down = new Set<number>();
  let moved: PointerEvent | undefined;
  let frame = 0;
  const at = (e: PointerEvent, type: Pointer["type"]): Pointer => {
    const box = el.getBoundingClientRect();
    const x = box.width ? ((e.clientX - box.left) / box.width) * view.width : 0;
    const y = box.height ? ((e.clientY - box.top) / box.height) * view.height : 0;
    return { canvas: view.id, type, x: Math.round(Math.min(view.width, Math.max(0, x))), y: Math.round(Math.min(view.height, Math.max(0, y))), id: e.pointerId, kind: e.pointerType || "mouse" };
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
