// A project's own kernel.json (docs/guide/your-own-app.md, docs/layers.md).
//
// A project has the platform as a dependency and builds no kernel: it serves
// and deploys the ones the platform built. Each of those carries a mark where
// a site's kernel.json goes (STAMP in vite.kernel-modules.ts). When the
// project has a kernel.json at its top, `extensible-app` checks it by the
// same rules as the platform's own, and writes it after the mark in the
// project's copies of the kernels, in .extensible/:
//
//   the browser's      dist/assets/browser-<hash>.js, served at the same address
//   Node's             .build/server/space.js, which `extensible-app dev` runs for spaces
//   Cloudflare's       .build/cloudflare/kernel-source.js, which the deployed Worker loads for spaces
//
// So the project's kernel runs only the modules its kernel.json lists, with
// its hook limits, in the browser and on its servers alike. The platform's
// own files in node_modules are never changed.
//
// A kernel.json that names a module this version of the platform doesn't
// have, a setting or limit it doesn't know, or a platform whose kernels have
// no mark, stops the command: a project's settings are never quietly ignored.
// With no kernel.json, a project runs the platform's kernels as they are.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

/** This package: the platform. */
const PLATFORM = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let rules;
/** The platform's own kernel.json rules (vite.kernel-modules.ts), bundled: Node won't strip a .ts file's types inside node_modules. */
function kernelRules(platform) {
  if (rules?.platform === platform) return rules;
  const out = buildSync({
    stdin: { contents: 'export { STAMP, listedModules, hookLimits } from "./vite.kernel-modules.ts";', resolveDir: platform, loader: "ts" },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    external: ["node:*", "vite"],
    logLevel: "silent",
  });
  // Run here rather than imported, so every command that lays a project out stays one step, with nothing to await.
  const module = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(module, module.exports, createRequire(join(platform, "package.json")));
  rules = { platform, ...module.exports };
  return rules;
}

/**
 * The project's kernel.json, checked: its modules (each one the platform it depends on has) and its hook
 * limits. Undefined when the project has none, which means the platform's kernels as they are.
 * @param {string} project @param {{ platform?: string }} [options]
 * @returns {{ modules: string[], hooks?: Record<string, number> } | undefined}
 */
export function projectKernel(project, { platform = PLATFORM } = {}) {
  if (!existsSync(join(project, "kernel.json"))) return undefined;
  const { listedModules, hookLimits } = kernelRules(platform);
  const has = listedModules(platform);
  let modules;
  try {
    modules = listedModules(project, platform);
  } catch (error) {
    // The rules say there is "no std/<name>/module.ts"; in a project, that is a module the platform doesn't have.
    const unknown = /^kernel\.json lists (\S+), but there is no/.exec(error.message)?.[1];
    throw unknown ? new Error(`Your kernel.json lists ${unknown}, which isn't one of the platform's kernel modules (they are ${has.join(", ")})`) : new Error(`Your ${error.message}`);
  }
  // A module the platform has in std/ but didn't build into its kernels can't be picked either.
  const unbuilt = modules.filter((name) => !has.includes(name));
  if (unbuilt.length) throw new Error(`Your kernel.json lists ${unbuilt.join(", ")}, which the platform's kernels weren't built with (they have ${has.join(", ")})`);
  let hooks;
  try {
    hooks = hookLimits(project);
  } catch (error) {
    throw new Error(`Your ${error.message}`);
  }
  return Object.keys(hooks).length ? { modules, hooks } : { modules };
}

/**
 * A built kernel's text with the project's kernel.json written after its mark. Throws if the text hasn't
 * exactly one mark: a kernel this can't write to is never served as if it had been.
 * @param {string} text @param {{ modules: string[], hooks?: Record<string, number> }} settings @param {string} mark @param {string} what
 */
export function stamp(text, settings, mark, what) {
  // What follows the mark is base64, which has no character a JavaScript string (or one inside JSON) escapes.
  const at = new RegExp(`${mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Za-z0-9+/]*`, "g");
  const found = text.match(at) ?? [];
  if (found.length !== 1) throw new Error(`${what} has ${found.length || "no"} place${found.length > 1 ? "s" : ""} for a project's kernel.json: this version of the platform can't run one. Remove your kernel.json, or update the platform.`);
  // No padding: it would end the base64 where a copy stamped before is read again, and atob doesn't need it.
  return text.replace(at, mark + Buffer.from(JSON.stringify(settings)).toString("base64").replace(/=+$/, ""));
}

/**
 * The browser's kernel for the project: where the platform's is in its built site (`assets/browser-<hash>.js`),
 * and its text with the project's kernel.json in it, to serve at that same address.
 * @returns {{ path: string, text: string }}
 */
export function browserKernel(settings, { platform = PLATFORM } = {}) {
  const { STAMP } = kernelRules(platform);
  const assets = join(platform, "dist", "assets");
  const marked = readdirSync(assets).filter((name) => name.endsWith(".js") && readFileSync(join(assets, name), "utf8").includes(STAMP));
  if (marked.length !== 1) throw new Error(`The platform's built site has ${marked.length || "no"} kernel with a place for a project's kernel.json: this version of the platform can't run one. Remove your kernel.json, or update the platform.`);
  return { path: `assets/${marked[0]}`, text: stamp(readFileSync(join(assets, marked[0]), "utf8"), settings, STAMP, `The platform's ${marked[0]}`) };
}

/**
 * Node's kernel for the project, in `dir`: a copy of the platform's built server kernel (.build/server/) with
 * the project's kernel.json in it. The kernel imports cordis by name, so the copy gets a link to the platform's
 * own, wherever the project's package manager put it. Returns the kernel's file, for `serve({ kernel })`.
 */
export function nodeKernel(settings, dir, { platform = PLATFORM } = {}) {
  const { STAMP } = kernelRules(platform);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(platform, ".build", "server"), dir, { recursive: true, dereference: true });
  const kernel = join(dir, "space.js");
  const text = readFileSync(kernel, "utf8");
  writeFileSync(kernel, stamp(text, settings, STAMP, "The platform's kernel for Node"));
  const require = createRequire(join(platform, "package.json"));
  for (const name of new Set([...text.matchAll(/^import\b[^"'\n]*["']([^"'./][^"']*)["']/gm)].map((m) => m[1]).filter((n) => !n.startsWith("node:")))) {
    // The package's folder: up from whatever file its name resolves to, to its package.json.
    let folder = dirname(require.resolve(name));
    while (!existsSync(join(folder, "package.json")) || JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).name !== name) {
      if (dirname(folder) === folder) throw new Error(`Couldn't find the platform's ${name} package`);
      folder = dirname(folder);
    }
    mkdirSync(dirname(join(dir, "node_modules", name)), { recursive: true });
    // A junction needs no special rights on Windows; elsewhere the type is ignored.
    symlinkSync(folder, join(dir, "node_modules", name), "junction");
  }
  return kernel;
}

/**
 * Cloudflare's Worker for the project, in `dir`: a copy of the platform's Worker source (src/) and its built
 * kernel (.build/cloudflare/), with the project's kernel.json in the kernel. The kernel's version is made
 * again from its text, as the build makes it (vite.cloudflare.config.ts), so a space loads the new kernel
 * rather than one it kept. Returns the Worker's entry in the copy, for wrangler's `main`.
 * @param {string} main the platform's `main` in wrangler.jsonc
 */
export function cloudflareKernel(settings, dir, main, { platform = PLATFORM } = {}) {
  const { STAMP } = kernelRules(platform);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(platform, "src"), join(dir, "src"), { recursive: true, dereference: true });
  cpSync(join(platform, ".build", "cloudflare"), join(dir, ".build", "cloudflare"), { recursive: true, dereference: true });
  const file = join(dir, ".build", "cloudflare", "kernel-source.js");
  const written = /^((?:\/\/[^\n]*\n)*)export default (\{[^]*\});\n?$/.exec(readFileSync(file, "utf8"));
  const source = written && JSON.parse(written[2]);
  if (!source || typeof source.version !== "string" || !source.modules || typeof source.modules !== "object") throw new Error("The platform's kernel for Cloudflare isn't written as this version of extensible-app reads it: update the platform.");
  const text = JSON.stringify(source.modules);
  // Checked across every module of the kernel together, so there is exactly one mark in all of it.
  stamp(text, settings, STAMP, "The platform's kernel for Cloudflare");
  const modules = Object.fromEntries(Object.entries(source.modules).map(([name, code]) => [name, code.includes(STAMP) ? stamp(code, settings, STAMP, name) : code]));
  const version = createHash("sha256").update(JSON.stringify(modules)).digest("hex").slice(0, 12);
  writeFileSync(file, `${written[1]}export default ${JSON.stringify({ ...source, version, modules })};\n`);
  return join(dir, main);
}
