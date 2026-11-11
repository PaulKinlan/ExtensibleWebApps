// Writes /platform/parts.json: the built files an app fetches only when it
// first uses them (each kernel module, the parts of the kernel core and of the
// page's script that load on demand, the plugin runtimes). The service worker
// reads it and keeps them all ahead of time (sw/parts.js), so a part first
// used offline is already on the device.
//
// The list is this build's files only, by their built names. Files brought
// along from earlier deploys for pages still open (scripts/keep-assets.mjs)
// are added to dist/ after this runs, and are not in it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/** What is listed: every built script and stylesheet under assets/. */
const PART = /^assets\/[\w.-]+\.(js|css)$/;

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
        .map((file) => `/${file}`);
      writeFileSync(join(outDir, "platform", "parts.json"), `${JSON.stringify({ files }, null, 1)}\n`);
    },
  };
}
