// The "canvas" view: a canvas a plugin draws on from its worker, through an
// OffscreenCanvas. It goes with the page's theme (../canvas-theme.ts), since a
// worker can't read CSS. With `pointer: true`, taps and drags on it go to the
// plugin as `canvas:pointer` events (../canvas-live.ts). A template can hold
// the same thing as <canvas id="…" width height pointer>.

import { canDraw, liveCanvas, needsTabNote } from "../canvas-live";
import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"canvas">, host: ViewHost): HTMLElement => {
  if (!canDraw(host.owner, host.tab)) return needsTabNote();
  const key = liveCanvas(view, host);
  // A stand-in; the live canvas takes its place once the view is drawn.
  const placeholder = document.createElement("canvas");
  placeholder.dataset.canvas = key;
  return placeholder;
};
