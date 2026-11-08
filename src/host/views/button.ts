// The "button" view: a button that sends its action.

import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"button">, _host: ViewHost): HTMLElement => {
  const el = document.createElement("button");
  el.textContent = view.label;
  if (view.primary) el.className = "primary";
  el.dataset.action = view.action;
  return el;
};
