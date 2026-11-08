// The "list" view: a list of choices, with the selected one marked.

import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"list">, _host: ViewHost): HTMLElement => {
  const el = document.createElement("ul");
  el.className = "list";
  for (const item of view.items) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = item.label;
    button.setAttribute("aria-current", String(Boolean(item.selected)));
    button.dataset.action = item.action;
    li.append(button);
    el.append(li);
  }
  return el;
};
