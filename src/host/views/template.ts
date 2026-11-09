// The "template" view: a <template> from a file the plugin ships, filled with
// its data (templates.ts) and then sanitised like any HTML view. The file's
// <style>, if it has one, is scoped to this plugin's views (plugin-styles.ts).

import { placeCanvases } from "../canvas-live";
import { sanitize } from "../sanitize";
import { installPluginStyle } from "../plugin-styles";
import { fill, loadedFile, styleOf } from "../templates";
import type { ViewHost, ViewOf } from "./index";

export default (view: ViewOf<"template">, host: ViewHost): HTMLElement => {
  const { owner } = host;
  // render() has made sure the file is loaded.
  const file = loadedFile(view.src)!;
  installPluginStyle(owner.split("@")[0], view.src, styleOf(file));
  const el = document.createElement("div");
  el.className = "html-view";
  el.append(sanitize(fill(file, view.id, view.data), owner, { remote: view.remote === true, base: view.src }));
  // A <canvas id> in the template is one the plugin draws on (canvas-live.ts).
  placeCanvases(el, host);
  return el;
};
