// The "heading" view: a heading.

import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"heading">, _host: ViewHost): HTMLElement => {
  const el = document.createElement("h2");
  el.textContent = view.text;
  return el;
};
