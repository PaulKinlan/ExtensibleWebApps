// The kernel's layers (docs/layers.md): every file in src/kernel/ is either
// core, which every app and space server needs, or a kernel service an app
// may not use. A new file has to say which, here and on that page, so the
// core can't grow by accident. A file on neither list fails the check.
import { existsSync, readdirSync, readFileSync } from "node:fs";

const KERNEL = new URL("../../src/kernel/", import.meta.url);

/** Needed to run any plugin, in any app or space server. */
const CORE = [
  "address.ts",
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
  "manifest.ts",
  "modules.ts",
  "moves.ts",
  "net.ts",
  "paths.ts",
  "provided.ts",
  "records.ts",
  "reference.ts",
  "remote.ts",
  "review.ts",
  "routes.ts",
  "schema.ts",
  "secrets.ts",
  "services/files.ts",
  "services/hooks.ts",
  "services/index.ts",
  "services/kernel.ts",
  "services/storage.ts",
  "store.ts",
  "switches.ts",
  "trace.ts",
  "user-plugins.ts",
];

/** Kernel services an app may not use, and the files that belong to them, being split out of the core. */
const SERVICES = [
  "agents/file.ts",
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
}
