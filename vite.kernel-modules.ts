// The kernel's modules, as the site chose them (docs/layers.md). kernel.json
// lists them by name; each is std/<name>/module.ts. Every build that makes a
// kernel (the browser's, Node's and Cloudflare's) uses this, so the import
// `virtual:kernel-modules` in src/kernel/kernel.ts is the listed modules, in
// order, and nothing else is built in. A name with no module.ts, or one
// listed twice, stops the build.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const ID = "virtual:kernel-modules";
const NAME = /^[a-z][a-z0-9-]*$/;

/** The module names kernel.json lists, checked. */
export function listedModules(root = process.cwd()): string[] {
  const file = resolve(root, "kernel.json");
  const { modules } = JSON.parse(readFileSync(file, "utf8")) as { modules?: unknown };
  if (!Array.isArray(modules)) throw new Error("kernel.json needs a `modules` list");
  const seen = new Set<string>();
  for (const name of modules) {
    if (typeof name !== "string" || !NAME.test(name)) throw new Error(`kernel.json: ${JSON.stringify(name)} isn't a module name`);
    if (seen.has(name)) throw new Error(`kernel.json lists ${name} twice`);
    if (!existsSync(resolve(root, "std", name, "module.ts"))) throw new Error(`kernel.json lists ${name}, but there is no std/${name}/module.ts`);
    seen.add(name);
  }
  return modules as string[];
}

export function kernelModules(): Plugin {
  return {
    name: "kernel-modules",
    resolveId: (id) => (id === ID ? `\0${ID}` : undefined),
    load(id) {
      if (id !== `\0${ID}`) return;
      const root = process.cwd();
      this.addWatchFile(resolve(root, "kernel.json"));
      const names = listedModules(root);
      const imports = names.map((name, i) => `import m${i} from ${JSON.stringify(resolve(root, "std", name, "module.ts"))};`);
      return `${imports.join("\n")}\nexport default [${names.map((_, i) => `m${i}`).join(", ")}];\n`;
    },
  };
}
