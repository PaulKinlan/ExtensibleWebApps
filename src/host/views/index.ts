// The views a plugin can draw, a file each, found by name: views/<type>.ts
// draws a view whose `type` is <type>. A new kind of view is a new file here
// (and its shape in View, in shared/protocol.ts), so two changes that each add
// one don't edit the same lines.
//
// Each file's default export takes the view and what drawing needs from the
// host, and returns the element.

import type { HostToKernel, View } from "../../shared/protocol";

export type ViewOf<T extends View["type"]> = Extract<View, { type: T }>;

export interface ViewHost {
  /** The plugin instance drawing, as `plugin@tab` or `plugin`. */
  owner: string;
  /** This tab's id. */
  tab: string;
  send(message: HostToKernel, transfer?: Transferable[]): void;
  /** Live canvases, by `owner/id`, so a redraw keeps the one its worker draws on. */
  canvases: Map<string, HTMLCanvasElement>;
  /** Draws a child view for the same owner. */
  element(view: View): HTMLElement;
}

type Draw = (view: View, host: ViewHost) => HTMLElement;
const files = import.meta.glob<{ default: Draw }>(["./*.ts", "!./index.ts"], { eager: true });
const draws = new Map(Object.entries(files).map(([path, file]) => [path.slice(2, -3), file.default]));

export function drawView(view: View, host: ViewHost): HTMLElement {
  const draw = draws.get(view.type);
  if (!draw) throw new Error(`The host has no view of type ${view.type}`);
  return draw(view, host);
}
