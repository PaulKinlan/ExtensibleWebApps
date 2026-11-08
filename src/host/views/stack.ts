// The "stack" view: views side by side, or one above the other.

import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"stack">, { element }: ViewHost): HTMLElement => {
  const el = document.createElement("div");
  el.className = `stack${view.direction === "row" ? " row" : ""}`;
  for (const child of view.children) el.append(element(child));
  return el;
};
