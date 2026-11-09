// The kernel's modules, as the site chose them (docs/layers.md). kernel.json
// lists them by name; each is std/<name>/module.ts. Every build that makes a
// kernel (the browser's, Node's and Cloudflare's) uses this, so the import
// `virtual:kernel-modules` in src/kernel/kernel.ts is the listed modules, in
// order, and nothing else is built in. A name with no module.ts, or one
// listed twice, stops the build.
//
// kernel.json may also set the limits on hooks plugins define (`hooks`: see
// PLUGIN_HOOKS in src/kernel/hooks.ts), exported as `hookLimits`. A key the
// kernel doesn't know, or a value that isn't a whole number above 0, stops
// the build too: a site's settings are never quietly ignored.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const ID = "virtual:kernel-modules";
const NAME = /^[a-z][a-z0-9-]*$/;

/** What kernel.json may say. */
const KEYS = ["modules", "hooks"];
/** The hook limits a site may change, as PLUGIN_HOOKS names them. */
const HOOK_LIMITS = ["max", "defaultTimeoutMs", "timeoutMs", "agentTimeoutMs", "maxValue"];

function readKernelJson(root: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(resolve(root, "kernel.json"), "utf8")) as unknown;
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("kernel.json must be an object");
  for (const key of Object.keys(json)) if (!KEYS.includes(key)) throw new Error(`kernel.json: ${JSON.stringify(key)} isn't a setting (it may have ${KEYS.join(" and ")})`);
  return json as Record<string, unknown>;
}

/** The hook limits kernel.json sets, checked: only those PLUGIN_HOOKS has, each a whole number above 0. */
export function hookLimits(root = process.cwd()): Record<string, number> {
  const { hooks } = readKernelJson(root);
  if (hooks === undefined) return {};
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new Error("kernel.json: `hooks` must be an object of limits");
  for (const [key, value] of Object.entries(hooks)) {
    if (!HOOK_LIMITS.includes(key)) throw new Error(`kernel.json: hooks.${key} isn't a limit (they are ${HOOK_LIMITS.join(", ")})`);
    if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`kernel.json: hooks.${key} must be a whole number above 0`);
  }
  const limits = hooks as Record<string, number>;
  if (limits.defaultTimeoutMs !== undefined && limits.timeoutMs !== undefined && limits.defaultTimeoutMs > limits.timeoutMs) throw new Error("kernel.json: hooks.defaultTimeoutMs can't be more than hooks.timeoutMs");
  return limits;
}

/** The module names kernel.json lists, checked. */
export function listedModules(root = process.cwd()): string[] {
  const { modules } = readKernelJson(root);
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
      return `${imports.join("\n")}\nexport default [${names.map((_, i) => `m${i}`).join(", ")}];\nexport const hookLimits = ${JSON.stringify(hookLimits(root))};\n`;
    },
  };
}
