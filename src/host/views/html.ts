// The "html" view: HTML a plugin wrote, sanitised (sanitize.ts). A <canvas id>
// in it becomes one the plugin draws on (../drawing.ts).

import { canvasTheme } from "../canvas-theme";
import { placeCanvases } from "../drawing-hooks";
import { sanitize } from "../sanitize";
import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"html">, host: ViewHost): HTMLElement => {
  const el = document.createElement("div");
  el.className = "html-view";
  el.append(sanitize(view.html, host.owner, { remote: view.remote === true }));
  placeCanvases(el, host, canvasTheme);
  return el;
};
