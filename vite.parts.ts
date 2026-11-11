// Writes /platform/parts.json: the built files an app fetches only when it
// first uses them (each kernel module, the parts of the kernel core and of the
// page's script that load on demand, the plugin runtimes). The service worker
// reads it and keeps them all ahead of time (sw/parts.js), so a part first
// used offline is already on the device.
//
// The list is this build's files only, by their built names. Files brought
// along from earlier deploys for pages still open (scripts/keep-assets.mjs)
// are added to dist/ after this runs, and are not in it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/** What is listed: every built script and stylesheet under assets/. */
const PART = /^assets\/[\w.-]+\.(js|css)$/;

/**
 * The files of a standard plugin that waits for its first use (its manifest's `standIn`, as Customize has): its
 * templates and the ui-* elements they use, which no visit fetches until then. They keep their own addresses.
 */
function waitingPlugins(): string[] {
  const files = new Set<string>();
  for (const name of readdirSync("std")) {
    if (!name.endsWith(".js")) continue;
    const source = readFileSync(join("std", name), "utf8");
    if (!/\bstandIn:/.test(source)) continue;
    for (const [, template] of source.matchAll(/ui\.views\("([\w.-]+\.html)"\)/g)) {
      if (!existsSync(join("std", template))) continue;
      files.add(`/std/${template}`);
      for (const [, element] of readFileSync(join("std", template), "utf8").matchAll(/<(ui-[a-z-]+)/g))
        for (const kind of ["js", "html"]) if (existsSync(join("elements", `${element}.${kind}`))) files.add(`/elements/${element}.${kind}`);
    }
  }
  return [...files].sort();
}

export function onDemandParts(): Plugin {
  let outDir = "dist";
  return {
    name: "on-demand-parts",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    writeBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((file) => PART.test(file))
        .sort()
        .map((file) => `/${file}`)
        .concat(waitingPlugins());
      writeFileSync(join(outDir, "platform", "parts.json"), `${JSON.stringify({ files }, null, 1)}\n`);
    },
  };
}
