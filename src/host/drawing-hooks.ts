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
  copySvg(el: Element, scope: DrawScope): Element | null;
  canvasStandIn(el: Element, scope: DrawScope): Element;
  placeCanvases(root: ParentNode, host: CanvasHost): void;
  liveCanvas(spec: { id: string; width: number; height: number; pointer?: boolean }, host: CanvasHost): HTMLElement;
}

export let drawing: Drawing | undefined;
export const useDrawing = (loaded: Drawing) => void (drawing = loaded);

/** Makes the canvases in a drawn HTML view or template live (views/html.ts, views/template.ts). */
export function placeCanvases(root: ParentNode, host: Omit<CanvasHost, "theme">, theme: () => CanvasTheme): void {
  if (drawing && root.querySelector("canvas[data-canvas-id]")) drawing.placeCanvases(root, { ...host, theme });
}
