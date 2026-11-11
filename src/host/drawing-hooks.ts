// Where the host finds SVG and canvas support for views (drawing.ts) once
// drawing-gate.ts has loaded it. Until then there is none, and an <svg> or
// <canvas> in a view is dropped (a canvas view shows a note); the gate loads
// it before drawing a view that has one, so that only happens if it fails to
// load.

import type { ViewHost } from "./views/index";
import type { CanvasTheme } from "../shared/protocol";

/** What the sanitiser lends drawing.ts, so it imports nothing the host has (and stays one small file). */
export interface DrawScope {
  /** An attribute's value with its ids made the plugin's own (sanitize.ts). */
  scoped(name: string, value: string): string;
  /** The custom properties a style= may set, or undefined. */
  style(value: string): string | undefined;
  /** An id as the plugin's own: `x` is `cookbook--x`. */
  id(value: string): string;
  /** Attributes allowed on every element (html.ts). */
  globals: string[];
}

/** What a view lends drawing.ts to make its canvases live: the view host, and the page's theme for canvases. */
export type CanvasHost = Pick<ViewHost, "owner" | "tab" | "send" | "canvases"> & { theme(): CanvasTheme };

export interface Drawing {
  /** The page's theme as a canvas needs it, and a watch on it (canvas-theme.ts): part of drawing.ts, since only canvases use them. */
  canvasTheme(): CanvasTheme;
  watchCanvasTheme(changed: (theme: CanvasTheme) => void): void;
  copySvg(el: Element, scope: DrawScope): Element | null;
  canvasStandIn(el: Element, scope: DrawScope): Element;
  placeCanvases(root: ParentNode, host: CanvasHost): void;
  liveCanvas(spec: { id: string; width: number; height: number; pointer?: boolean }, host: CanvasHost): HTMLElement;
}

export let drawing: Drawing | undefined;
const waiting: ((loaded: Drawing) => void)[] = [];
export const useDrawing = (loaded: Drawing) => {
  drawing = loaded;
  for (const run of waiting.splice(0)) run(loaded);
};
/** Runs `run` with drawing.ts once it has loaded (at once, if it has): for what only matters when a view draws. */
export const whenDrawing = (run: (loaded: Drawing) => void) => void (drawing ? run(drawing) : waiting.push(run));

/** Makes the canvases in a drawn HTML view or template live (views/html.ts, views/template.ts). */
export function placeCanvases(root: ParentNode, host: Omit<CanvasHost, "theme">): void {
  if (drawing && root.querySelector("canvas[data-canvas-id]")) drawing.placeCanvases(root, { ...host, theme: drawing.canvasTheme });
}
