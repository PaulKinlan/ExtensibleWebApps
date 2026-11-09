// The kernel's modules, as the site chose them (docs/layers.md). kernel.json
// lists them by name; each is std/<name>/module.ts. Every build that makes a
// kernel (the browser's, Node's and Cloudflare's) uses this, so the import
// `virtual:kernel-modules` in src/kernel/kernel.ts is the listed modules, in
// order, and nothing else is built in. A name with no module.ts, or one
// listed twice, stops the build.
//
// Each module has a manifest beside it, std/<name>/module.json, which says
// what the module adds (the services it provides, the hooks it defines, the
// page commands, messages and doors it answers) and whether it starts with the
// kernel. The kernel reads the manifests, never the modules, as it starts: in
// the browser each module is a file of its own, fetched the first time
// something it adds is used (src/kernel/modules.ts), so an app downloads only
// the modules it uses. A module with no manifest, or a manifest with a key or
// value the kernel doesn't know, stops the build.
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

/** What a module's manifest (std/<name>/module.json) may say: what the module adds, by name. */
const ADDS = ["services", "hooks", "commands", "messages", "doors"] as const;
/** When a module starts by itself: with every kernel, or with a kernel that is for a space. Otherwise it starts when something it adds is first used. */
const STARTS = ["always", "space"];
export interface ModuleManifest {
  services?: string[];
  hooks?: string[];
  commands?: string[];
  messages?: string[];
  doors?: string[];
  starts?: "always" | "space";
}

/** A module's manifest, checked: only the keys above, each a list of names (and `starts` one of its two values). */
export function moduleManifest(name: string, root = process.cwd()): ModuleManifest {
  const file = resolve(root, "std", name, "module.json");
  if (!existsSync(file)) throw new Error(`std/${name}/module.ts has no manifest: add std/${name}/module.json saying what it adds (docs/layers.md)`);
  const json = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`std/${name}/module.json must be an object`);
  for (const [key, value] of Object.entries(json)) {
    if (key === "starts") {
      if (!STARTS.includes(value as string)) throw new Error(`std/${name}/module.json: starts must be ${STARTS.map((s) => JSON.stringify(s)).join(" or ")}`);
    } else if (!(ADDS as readonly string[]).includes(key)) throw new Error(`std/${name}/module.json: ${JSON.stringify(key)} isn't a setting (it may have ${[...ADDS, "starts"].join(", ")})`);
    else if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v) || new Set(value).size !== value.length) throw new Error(`std/${name}/module.json: ${key} must be a list of names, each once`);
  }
  return json as ModuleManifest;
}

/** Every listed module's manifest, checked together: no two modules add the same thing. */
export function moduleManifests(root = process.cwd()): Record<string, ModuleManifest> {
  const manifests = Object.fromEntries(listedModules(root).map((name) => [name, moduleManifest(name, root)]));
  for (const key of ADDS) {
    const owner = new Map<string, string>();
    for (const [name, manifest] of Object.entries(manifests))
      for (const added of manifest[key] ?? []) {
        if (owner.has(added)) throw new Error(`std/${name}/module.json and std/${owner.get(added)}/module.json both add ${added} to ${key}`);
        owner.set(added, name);
      }
  }
  return manifests;
}

/**
 * `split`: each module is a file of its own that the kernel fetches when it is first used (the browser's kernel).
 * Without it the modules are part of the kernel's own file (a server's kernel, which starts them all).
 */
export function kernelModules({ split = false }: { split?: boolean } = {}): Plugin {
  return {
    name: "kernel-modules",
    resolveId: (id) => (id === ID ? `\0${ID}` : undefined),
    load(id) {
      if (id !== `\0${ID}`) return;
      const root = process.cwd();
      this.addWatchFile(resolve(root, "kernel.json"));
      const names = listedModules(root);
      const manifests = moduleManifests(root);
      for (const name of names) this.addWatchFile(resolve(root, "std", name, "module.json"));
      const path = (name: string) => JSON.stringify(resolve(root, "std", name, "module.ts"));
      const imports = split ? [] : names.map((name, i) => `import m${i} from ${path(name)};`);
      const entry = (name: string, i: number) =>
        `{ name: ${JSON.stringify(name)}, manifest: ${JSON.stringify(manifests[name])}, ${split ? `load: () => import(${path(name)}).then((m) => m.default)` : `module: m${i}`} }`;
      return `${imports.join("\n")}\nexport default [${names.map(entry).join(", ")}];\nexport const hookLimits = ${JSON.stringify(hookLimits(root))};\n`;
    },
  };
}
