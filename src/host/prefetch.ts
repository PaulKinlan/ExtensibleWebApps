// Starts loading what a page's views will need before they ask for it, so
// the files load while the kernel and the plugin workers start, not one after
// another once the first view arrives.
//
//   a plugin's source  → the template files it names: ctx.ui.views("x.html")
//   a manifest's `code` → that file, later, and the templates it names
//   a template file     → the ui-* elements its templates use
//   an element's file   → the ui-* elements inside its own template (elements.ts)
//
// It is only a head start. The kernel still checks each template a plugin
// draws (src/kernel/remote.ts), and the host loads it the usual way; a file
// fetched early is simply there already. A guess that is wrong costs one
// request and is never reported: nothing asked for it.

import { loadElement } from "./elements";
import { loadFile } from "./templates";

/** `ctx.ui.views("x.html")` with a plain string, as the guide writes it. */
const VIEWS = /\.views\(\s*(["'`])([^"'`$\n]{1,200}\.html)\1\s*\)/g;
/** A ui-* tag in a template's markup, in any case. */
const ELEMENT = /<(ui-[a-z0-9-]+)[\s>/]/gi;

/** The template files a plugin's source names, as the kernel would resolve them: next to the plugin, on its site. */
export function templatesIn(href: string, source: string): string[] {
  const out = new Set<string>();
  const from = new URL(href, location.href);
  for (const match of source.matchAll(VIEWS)) {
    try {
      const src = new URL(match[2], from);
      if (src.origin === from.origin && src.origin === location.origin && !src.search && !src.hash) out.add(src.href);
    } catch {
      // Not a URL: the plugin will find out when it draws.
    }
  }
  return [...out];
}

/** The ui-* elements named in some markup that aren't defined yet. */
export function elementsIn(markup: string): string[] {
  const out = new Set<string>();
  for (const match of markup.matchAll(ELEMENT)) {
    // Tag names are case-insensitive: <UI-CARD> is ui-card once parsed.
    const name = match[1].toLowerCase();
    if (!customElements.get(name)) out.add(name);
  }
  return [...out];
}

/** Loads the elements a parsed file's templates use. */
export function warmElements(file: Document | DocumentFragment | Element): void {
  const markup = [...file.querySelectorAll("template")].map((t) => t.innerHTML).join("\n");
  for (const name of elementsIn(markup)) void loadElement(name);
}

/** A manifest that names a `code` file: the rest of the plugin is in that file beside it, read when it first starts (plugin-code.ts). */
const CODE = /\bcode["']?\s*:/;

/**
 * Loads a plugin's template files, and through them their elements, while the plugin starts. A plugin that is
 * only its manifest (`code`) is needed for no first view: its code, and what that names, are fetched some
 * seconds on, so they are this visit's and there offline.
 */
export function warmPlugin(href: string, source: string): void {
  if (CODE.test(source)) return void setTimeout(() => import("./plugin-code").then((file) => file.warm(href, source), () => {}), 3000);
  for (const src of templatesIn(href, source)) loadFile(src).then(warmElements, () => {});
}
