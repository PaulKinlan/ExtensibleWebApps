// The "field" view: a labelled input. Its action is sent when the change is
// committed (blur, Enter, or a click), not on every key.

import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"field">, _host: ViewHost): HTMLElement => {
  const label = document.createElement("label");
  label.className = `field ${view.kind}`;
  const caption = document.createElement("span");
  caption.textContent = view.label;
  if (view.description) caption.title = view.description;
  let input: HTMLInputElement | HTMLSelectElement;
  if (view.kind === "select") {
    input = document.createElement("select");
    for (const option of view.options ?? []) input.append(new Option(option, option, option === view.value, option === view.value));
  } else {
    input = document.createElement("input");
    input.type = view.kind;
    if (view.kind === "checkbox") {
      if (view.value) input.setAttribute("checked", "");
    } else if (view.kind === "password") input.autocomplete = "off";
    else input.setAttribute("value", String(view.value));
  }
  input.name = view.name;
  input.dataset.action = view.action;
  if (view.kind === "checkbox") label.append(input, caption);
  else label.append(caption, input);
  return label;
};
