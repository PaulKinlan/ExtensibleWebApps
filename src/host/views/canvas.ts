// The "canvas" view: a canvas a plugin draws on from its worker, through an
// OffscreenCanvas. It goes with the page's theme (../canvas-theme.ts), since a
// worker can't read CSS. With `pointer: true`, taps and drags on it go to the
// plugin as `canvas:pointer` events. The work is in ../drawing.ts, loaded
// before the first view that has a canvas (../drawing-gate.ts); a template can
// hold the same thing as <canvas id="…" width height pointer>.

import { canvasTheme } from "../canvas-theme";
import { drawing } from "../drawing-hooks";
import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"canvas">, host: ViewHost): HTMLElement => {
  if (drawing) return drawing.liveCanvas(view, { ...host, theme: canvasTheme });
  const note = document.createElement("span");
  note.className = "muted";
  note.textContent = "Canvases couldn't load.";
  return note;
};
