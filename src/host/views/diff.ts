// The "diff" view: lines added, removed and kept.

import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"diff">, _host: ViewHost): HTMLElement => {
  const el = document.createElement("pre");
  el.className = "diff";
  for (const line of view.lines) {
    const span = document.createElement("span");
    span.className = line.op;
    span.textContent = `${line.op === "add" ? "+ " : line.op === "del" ? "- " : "  "}${line.text}`;
    el.append(span);
  }
  return el;
};
