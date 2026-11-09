// customize: what the Customize plugin (std/customize.js) needs from the page,
// through the authoring service: how each plugin's places went, which plugins
// run and which locked places each was let into, the samples the app offers,
// the file chooser, and inspect mode (inspect.ts).

import { fragile } from "../places";
import type { BridgeHost } from "./index";

/** Files a person picks to add as a plugin: the plugin's .js and the files it lists. */
const ACCEPT = ".js,.html,.css,.json,.svg,.png,.jpg,.jpeg,.webp,.gif";
/** The most a pick reads, all files together. */
const MAX = 5_000_000;

export default ({ places, running, inspect }: BridgeHost) => ({
  state: () => ({
    // fragile: the selector leans on the page's layout, so an update to the app may break it.
    places: places.status().map((p) => ({ ...p, fragile: fragile(p.at) })),
    running: running().map(({ id, name, user, unlocked, error }) => ({ id, name, user: !!user, unlocked: unlocked ?? [], ...(error ? { error } : {}) })),
    samples: [...document.querySelectorAll<HTMLLinkElement>('link[rel~="plugin-sample"]')].map((link) => ({ href: link.href, title: link.title || link.getAttribute("href") || "" })),
    inspect: !!inspect,
  }),
  /** Opens the file chooser (only right after the person clicks) and reads what they pick, as text or as a Blob for images. */
  pick: (): Promise<{ name: string; data: string | Blob }[] | null> => {
    if (navigator.userActivation && !navigator.userActivation.isActive) return Promise.reject(new Error("Files can be chosen only right after the person clicks"));
    return new Promise((resolve, reject) => {
      const input = Object.assign(document.createElement("input"), { type: "file", accept: ACCEPT, multiple: true, hidden: true });
      input.addEventListener("cancel", () => resolve(null));
      input.addEventListener("change", () => {
        const files = [...(input.files ?? [])];
        input.remove();
        if (!files.length) return resolve(null);
        if (files.reduce((n, f) => n + f.size, 0) > MAX) return reject(new Error(`Pick at most ${MAX / 1_000_000} MB of files`));
        Promise.all(files.map(async (f) => ({ name: f.name, data: /\.(js|html|css|json|svg)$/.test(f.name) ? await f.text() : (f as Blob) }))).then(resolve, reject);
      });
      document.body.append(input);
      input.click();
    });
  },
  inspect: () => {
    if (!inspect) throw new Error("This page has no inspect mode");
    inspect();
    return true;
  },
});
