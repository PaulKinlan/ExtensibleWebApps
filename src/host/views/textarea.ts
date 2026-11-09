// The "textarea" view: a text box. Plugins see edits after a short pause, as
// editor extensions do, and, if it asks, the selection, pastes and drops.

import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"textarea">, _host: ViewHost): HTMLElement => {
  const el = document.createElement("textarea");
  el.name = view.name;
  el.value = view.value;
  el.textContent = view.value;
  if (view.placeholder) el.placeholder = view.placeholder;
  el.dataset.action = view.action;
  el.dataset.live = "";
  // Editor events (editing.ts): the selection, pastes and drops, if the plugin asked for them.
  if (view.selectionAction) el.dataset.selectionAction = view.selectionAction;
  if (view.pasteAction) el.dataset.pasteAction = view.pasteAction;
  if (view.dropAction) el.dataset.dropAction = view.dropAction;
  return el;
};
