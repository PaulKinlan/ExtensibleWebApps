// Checks apps and their plugins without opening a browser, and says what to
// fix: the mistakes the kernel would otherwise only report at run time, in
// the trace. It reads the files as written, so it needs no build.
//
//   npm run check                    every app in demos/
//   npm run check demos/habits       one app (a folder with an app.html, or the file)
//   npm run check -- --json          the same, as JSON, for tools and agents
//
// What it checks, for each app:
//   app.html   loads the platform, links at least one plugin, and has a
//              <slot> for every slot a plugin draws into
//   plugins    the manifest is the first statement and a plain literal, ids
//              are unique, and every ctx call the code makes is allowed by
//              `permissions` (read from the same tables as docs/api.md)
//   views      each ctx.ui.views("x.html") file exists, has the templates the
//              code draws, and uses only HTML the sanitiser keeps
//   agents     each <link rel="agent"> file's frontmatter reads as the manifest
//              the kernel makes from it, with an id no plugin uses
//
// The checks themselves are std/maker/checks.js, the same module the app
// maker runs on an app made in the browser: this script reads the files from
// disk and hands it the kernel's rules. It reads the source, so it can only
// follow names written as plain strings: ctx.call("data", "put", "library", …)
// is checked, ctx.call(service, …) isn't.
// It exits with 1 if there is any error; warnings alone don't fail it.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { checkApp } from "../std/maker/checks.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The kernel's own manifest reader, capability gate and HTML allowlist,
// bundled from src/ so this script can never disagree with them.
async function loadKernelRules() {
  const entry = [
    'export { readManifest, RESERVED } from "./src/kernel/manifest.ts";',
    'export { PLUGIN_HOOKS } from "./src/kernel/hooks.ts";',
    // Through this bundle, not an import: Node won't strip a .ts file's types inside node_modules, where a project's copy of this script is.
    'export { hookLimits } from "./vite.kernel-modules.ts";',
    'export { capabilities, grants } from "./src/kernel/gate.ts";',
    'export * from "./src/shared/html.ts";',
    'export { fromAgentFile } from "./src/kernel/agents/file.ts";',
    'export { runnerName, DEFAULT_RUNNER } from "./src/shared/agent-runner.ts";',
  ].join("\n");
  // `?raw` imports (the agent loop's source) as text, as Vite does.
  const raw = { name: "raw", setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.slice(0, -4)), namespace: "raw" }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({ contents: readFileSync(a.path, "utf8"), loader: "text" }));
  } };
  const out = await build({ stdin: { contents: entry, resolveDir: ROOT, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:*"], logLevel: "silent", plugins: [raw] });
  const rules = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
  // The hook limits the site set in kernel.json, as the kernel uses them.
  Object.assign(rules.PLUGIN_HOOKS, rules.hookLimits(ROOT));
  // The kernel reserves each service's name when it loads src/kernel/services/,
  // so reserve the same names here, read from the same folder.
  for (const name of serviceFiles()) rules.RESERVED.add(name);
  return rules;
}

/**
 * The services that are a file each in src/kernel/services/ (the file's name is the service's), and the
 * kernel modules the site lists in kernel.json, each of which provides the service it is named after.
 */
function serviceFiles() {
  const files = readdirSync(join(ROOT, "src/kernel/services")).filter((f) => f.endsWith(".ts") && f !== "index.ts").map((f) => f.slice(0, -3));
  const { modules } = JSON.parse(readFileSync(join(ROOT, "kernel.json"), "utf8"));
  return [...files, ...modules];
}

// What each service method and hook needs, read from docs/api.md, which the
// kernel writes (and the tests keep up to date).
function loadReference() {
  const md = readFileSync(join(ROOT, "docs/api.md"), "utf8");
  const methods = new Map();
  for (const m of md.matchAll(/^#### (\w+)\.(\w+)\n[^]*?^Needs: (.*)$/gm)) {
    const needs = [...m[3].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
    methods.set(`${m[1]}.${m[2]}`, needs);
  }
  const hooks = new Map();
  for (const m of md.matchAll(/^### `([^`]+)`\n[^]*?Listening needs `?([^`.\s]+)`?/gm)) hooks.set(m[1], m[2]);
  return { methods, hooks };
}

/** A path as a link or ctx.ui.views gives it: from the site's root if it starts with /, else next to `from`; no query or fragment. */
const local = (path, from) => {
  const clean = path.replace(/[?#].*$/, "");
  if (!clean.startsWith("/")) return join(dirname(from), clean);
  // The site's own pages are in site/, served at the root (vite.config.ts): /workbench/plugins/x.js is site/workbench/plugins/x.js.
  const top = join(ROOT, clean);
  const site = join(ROOT, "site", clean);
  return !existsSync(top) && existsSync(site) ? site : top;
};
const rel = (file) => relative(ROOT, file) || ".";

export async function checkApps(targets) {
  const rules = await loadKernelRules();
  const reference = loadReference();
  const apps = targets.length ? targets.map(appFile) : demoApps();
  return apps.map((file) => checkAppFile(file, rules, reference));
}

function demoApps() {
  const demos = join(ROOT, "demos");
  return readdirSync(demos)
    .map((name) => join(demos, name, "app.html"))
    .filter((file) => existsSync(file))
    .sort();
}

function appFile(target) {
  const path = resolve(target);
  return existsSync(path) && statSync(path).isDirectory() ? join(path, "app.html") : path;
}

/** One app on disk, read by the checks every app gets (std/maker/checks.js), with the kernel's rules and the reference. */
function checkAppFile(file, rules, reference) {
  // Every service a call may name: the kernel's files and modules, and each one the reference documents.
  const services = new Set([...serviceFiles(), ...[...reference.methods.keys()].map((k) => k.split(".")[0])]);
  const { problems, plugins } = checkApp(
    {
      page: file,
      read: (key) => (existsSync(key) && statSync(key).isFile() ? readFileSync(key, "utf8") : undefined),
      resolve: (href, from) => (/^[a-z][\w+.-]*:/i.test(href) ? undefined : local(href, from)),
      label: rel,
      own: () => true,
    },
    { ...rules, ...reference, services },
  );
  return { app: rel(dirname(file)), plugins: plugins.map((p) => p.id), problems };
}

function print(apps) {
  let errors = 0;
  let warnings = 0;
  for (const app of apps) {
    const mine = app.problems;
    errors += mine.filter((p) => p.level === "error").length;
    warnings += mine.filter((p) => p.level === "warning").length;
    console.log(`${mine.length ? "✗" : "✓"} ${app.app}${app.plugins.length ? ` (${app.plugins.join(", ")})` : ""}`);
    for (const p of mine) console.log(`    ${p.level.padEnd(7)} ${p.file}${p.line ? `:${p.line}` : ""}  ${p.message}`);
  }
  console.log(`\n${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const apps = await checkApps(args.filter((a) => a !== "--json"));
  if (args.includes("--json")) console.log(JSON.stringify({ ok: apps.every((a) => !a.problems.some((p) => p.level === "error")), apps }, null, 2));
  else print(apps);
  process.exitCode = apps.some((a) => a.problems.some((p) => p.level === "error")) ? 1 : 0;
}
