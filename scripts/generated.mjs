// Files the site serves that are made from other files: the plugin registry, made from every plugin's
// manifest (scripts/packages.mjs), and the demo gallery's lists, made from each demo's <meta> tags
// (scripts/gallery.mjs). They are never committed, so two pull requests that each add a plugin or a demo
// can't conflict over them. vite.config.ts makes them as it serves the site in development, and writes
// them into dist/ at build, so every host (Cloudflare, `npm run serve`, a project of your own) has them.
//
// demos/index.html is committed with its lists empty: the build fills them. The tests check both.
import { expected } from "./packages.mjs";
import { render as gallery } from "./gallery.mjs";

/** Each generated file's path from the site's root, which is also where it is in the repo. */
export const PATHS = ["demos/index.html", "packages/catalog.json", "packages/index.html", "packages/index.json"];

/** Every generated file as it should be now, by its path. An app or plugin that can't be described throws. */
export async function generated() {
  const registry = await expected();
  return {
    "demos/index.html": gallery(),
    ...Object.fromEntries(Object.entries(registry).map(([name, text]) => [`packages/${name}`, text])),
  };
}
