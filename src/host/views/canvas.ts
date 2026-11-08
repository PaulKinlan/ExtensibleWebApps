// The "canvas" view: a canvas a plugin draws on from its worker, through an
// OffscreenCanvas. It goes with the page's theme (../canvas-theme.ts), since a
// worker can't read CSS.

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
    const offscreen = el.transferControlToOffscreen();
    send({ t: "canvas", owner, id: view.id, canvas: offscreen, theme: canvasTheme() }, [offscreen]);
    canvases.set(key, el);
  }
  // A stand-in; the live canvas takes its place once the view is drawn.
  const placeholder = document.createElement("canvas");
  placeholder.dataset.canvas = key;
  return placeholder;
};
