// The "text" view: a line of text, with an optional tone.

import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"text">, _host: ViewHost): HTMLElement => {
  const el = document.createElement("span");
  el.textContent = view.text;
  if (view.title) el.title = view.title;
  if (view.tone) el.className = view.tone;
  return el;
};
