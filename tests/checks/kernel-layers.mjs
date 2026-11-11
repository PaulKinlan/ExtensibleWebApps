// The kernel's layers (docs/layers.md): every file in src/kernel/ is either
// core, which every app and space server needs, or a kernel service an app
// may not use. A new file has to say which, here and on that page, so the
// core can't grow by accident. A file on neither list fails the check.
import { existsSync, readdirSync, readFileSync } from "node:fs";

const KERNEL = new URL("../../src/kernel/", import.meta.url);

/** Needed to run any plugin, in any app or space server. */
const CORE = [
  "address.ts",
  "agents/linked.ts",
  "apps.ts",
  "authoring.ts",
  "browser-env.ts",
  "browser.ts",
  "catalog.ts",
  "changes.ts",
  "diff.ts",
  "env.ts",
  "gate.ts",
  "hooks.ts",
  "hosts.ts",
  "isolate-host.ts",
  "kernel-modules.d.ts",
  "kernel.ts",
  "legacy.ts",
  "manifest-fields.ts",
  "manifest.ts",
  "modules.ts",
  "moves.ts",
  "net.ts",
  "panel-commands.ts",
  "part.ts",
  "paths.ts",
  "provided.ts",
  "records.ts",
  "reference.ts",
  "remote.ts",
  "review-batch.ts",
  "review.ts",
  "routes.ts",
  "schema.ts",
  "secrets-card.ts",
  "secrets.ts",
  "services/files.ts",
  "services/hooks.ts",
  "services/index.ts",
  "services/kernel.ts",
  "services/storage.ts",
  "store.ts",
  "switches.ts",
  "trace.ts",
  "user-plugin-changes.ts",
  "user-plugins.ts",
];

/** Kernel services an app may not use, and the files that belong to them, being split out of the core. */
const SERVICES = [
  "agents/file.ts",
];

/**
 * Files of src/kernel/ the kernel fetches when they are first needed, never with its own file: only some apps use
 * them (docs/layers.md, "The kernel stays small"). No other file of src/kernel/ may import one, except for its
 * types or with import().
 */
const ON_DEMAND = [
  "agents/file.ts",
  "authoring.ts",
  "manifest-fields.ts",
  "panel-commands.ts",
  "reference.ts",
  "review-batch.ts",
  "secrets-card.ts",
  "user-plugin-changes.ts",
];

const files = (dir = "") =>
  readdirSync(new URL(dir, KERNEL), { withFileTypes: true }).flatMap((e) =>
    e.name.startsWith(".") ? [] : e.isDirectory() ? files(`${dir}${e.name}/`) : [`${dir}${e.name}`],
  );

export default async function ({ check }) {
  const all = files();
  const unknown = all.filter((path) => !CORE.includes(path) && !SERVICES.includes(path));
  check("every file in src/kernel/ is listed as core or as a kernel service (docs/layers.md)", !unknown.length, unknown.join(", "));
  const gone = [...CORE, ...SERVICES].filter((path) => !all.includes(path));
  check("every file the layers list is still there", !gone.length, gone.join(", "));
  const page = readFileSync(new URL("../../docs/layers.md", import.meta.url), "utf8");
  // By its whole path (a link to ../src/kernel/<path>), so a file can't pass on another's name.
  const missing = [...CORE, ...SERVICES].filter((path) => !page.includes(`src/kernel/${path})`));
  check("docs/layers.md links every file in src/kernel/, by its whole path", !missing.length, missing.join(", "));
  // The kernel modules the site runs (kernel.json): each is std/<name>/module.ts, and the layers page names it.
  const { modules } = JSON.parse(readFileSync(new URL("../../kernel.json", import.meta.url), "utf8"));
  const absent = modules.filter((name) => !existsSync(new URL(`../../std/${name}/module.ts`, import.meta.url)));
  check("every module kernel.json lists is a std/<name>/module.ts", !absent.length, absent.join(", "));
  check("kernel.json lists its modules one per line, sorted", JSON.stringify([...modules].sort()) === JSON.stringify(modules), modules.join(", "));
  const unnamed = modules.filter((name) => !page.includes(`std/${name}/module.ts`));
  check("docs/layers.md names every kernel module", !unnamed.length, unnamed.join(", "));
  // A module adds hooks with kernel.hook and cleans up with kernel.cleanup, so all it adds goes when it stops.
  // defineHook, or setting one of the core's callbacks (remote.onDispose = …), would outlive it, and Cordis never fires ctx.on("dispose").
  const unscoped = modules.filter((name) => /\bdefineHook\b|\bhooks\.set\(|on\(\s*["']dispose["']|\.on[A-Z]\w*\s*=[^=]/.test(readFileSync(new URL(`../../std/${name}/module.ts`, import.meta.url), "utf8")));
  check("kernel modules add hooks and clean up only through their kernel, so stopping one takes it all back", !unscoped.length, unscoped.join(", "));

  // The kernel stays small (docs/layers.md): the core's own file has no kernel module in it, and none of the
  // parts of the core that only some apps use. Each is fetched when first needed, with import().
  const staticImports = (path) =>
    [...readFileSync(new URL(path, KERNEL), "utf8").matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => new URL(m[1], new URL(path, KERNEL)).pathname);
  const std = new URL("../../std/", import.meta.url).pathname;
  const builtIn = all.filter((path) => /\.ts$/.test(path)).flatMap((path) => staticImports(path).filter((to) => to.startsWith(std)).map((to) => `${path} imports std/${to.slice(std.length)}`));
  check("no file in src/kernel/ imports a kernel module or anything else in std/: modules are fetched when used", !builtIn.length, builtIn.join("; "));
  const onDemand = ON_DEMAND.map((path) => new URL(path, KERNEL).pathname.replace(/\.ts$/, ""));
  const pulledIn = all
    .filter((path) => /\.ts$/.test(path) && !ON_DEMAND.includes(path))
    .flatMap((path) => staticImports(path).filter((to) => onDemand.includes(to.replace(/\.ts$/, ""))).map((to) => `${path} imports ${to.slice(KERNEL.pathname.length)}`));
  check("the parts of the core only some apps use (the reference, authoring, the agent file reader) are fetched with import(), never imported by the rest", !pulledIn.length, pulledIn.join("; "));
  const noManifest = modules.filter((name) => !existsSync(new URL(`../../std/${name}/module.json`, import.meta.url)));
  check("every kernel module has its manifest beside it, std/<name>/module.json", !noManifest.length, noManifest.join(", "));
}
