// The "html" view: HTML a plugin wrote, sanitised (sanitize.ts).

import { sanitize } from "../sanitize";
import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"html">, { owner }: ViewHost): HTMLElement => {
  const el = document.createElement("div");
  el.className = "html-view";
  el.append(sanitize(view.html, owner, { remote: view.remote === true }));
  return el;
};
