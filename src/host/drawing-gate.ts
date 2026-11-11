// SVG and canvas support in views loads only when a view needs it: most apps
// draw neither, so the SVG list and copier and the template canvas code
// (drawing.ts) stay out of the page's script until one does. main.ts asks
// needsDrawing() before drawing a view and waits for loadDrawing(), as it
// waits for a template file or a ui-* element.

import type { View } from "../shared/protocol";
import { useDrawing } from "./drawing-hooks";
import { loadedFile } from "./templates";

const DRAWS = /<(svg|canvas)[\s/>]/i;
let loading: Promise<void> | undefined;
/** Loaded, or given up on: either way views stop waiting. */
let settled = false;

/** True if `view` holds an <svg> or <canvas> and drawing.ts hasn't loaded yet. */
export function needsDrawing(view: View): boolean {
  if (settled) return false;
  if (view.type === "canvas") return true;
  if (view.type === "html") return DRAWS.test(view.html);
  // Any template in the file: a file that draws in one view usually draws in the next.
  if (view.type === "template") return DRAWS.test(loadedFile(view.src)?.documentElement.innerHTML ?? "");
  if (view.type === "stack") return view.children.some(needsDrawing);
  return false;
}

/** Loads drawing.ts once. If it can't load, an <svg> or <canvas> is dropped like any element the host doesn't know. */
export function loadDrawing(): Promise<void> {
  // Built as its own file, named for its content like every other part (/assets/drawing-<hash>.js), so a host and
  // the drawing code it loads are always from the same build: at one fixed address, the service worker could hand
  // a new host the copy it kept from the build before.
  loading ??= import("./drawing").then(
    (m) => {
      useDrawing(m);
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return loading;
}
