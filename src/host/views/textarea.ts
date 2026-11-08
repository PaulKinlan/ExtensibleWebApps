// The "textarea" view: a text box. Plugins see edits after a short pause, as
// editor extensions do.

import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"textarea">, _host: ViewHost): HTMLElement => {
  const el = document.createElement("textarea");
  el.name = view.name;
  el.value = view.value;
  el.textContent = view.value;
  if (view.placeholder) el.placeholder = view.placeholder;
  el.dataset.action = view.action;
  el.dataset.live = "";
  return el;
};
