// The plugin registry's index (packages/index.json, served at
// /packages/index.json): one entry per package, sorted by id, read from each
// plugin's manifest. A package is a folder packages/<id>/ holding <id>.js and
// the files its manifest lists. Customize lists the index, so a person can add
// any of them to an app (docs/guide/plugin-registry.md).
//
//   npm run packages    rewrites packages/index.json and the page packages/index.html (the tests check both are current)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { hookLimits } from "../vite.kernel-modules.ts";

const ROOT = new URL("../packages/", import.meta.url);
const ID = /^[a-z][a-z0-9-]{0,63}$/;

/** The kernel's own manifest reader, bundled from src/ (as scripts/check.mjs does): it reads the manifest literal without running the plugin. */
async function manifestReader() {
  const out = await build({
    stdin: { contents: 'export { readManifest } from "./src/kernel/manifest.ts";\nexport { PLUGIN_HOOKS } from "./src/kernel/hooks.ts";', resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  const reader = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
  // The hook limits the site set in kernel.json, as the kernel uses them.
  Object.assign(reader.PLUGIN_HOOKS, hookLimits(fileURLToPath(new URL("..", import.meta.url))));
  return reader.readManifest;
}

/** The index, as it should be: an error for any folder that isn't a package. */
export async function buildIndex() {
  const readManifest = await manifestReader();
  const packages = [];
  for (const entry of readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const id = entry.name;
    const file = new URL(`${id}/${id}.js`, ROOT);
    if (!ID.test(id) || !existsSync(file)) throw new Error(`packages/${id}/ needs ${id}.js`);
    // Read as the kernel reads it, so nothing in the plugin runs here, and a manifest the kernel would refuse fails now.
    const manifest = readManifest(readFileSync(file, "utf8"));
    if (manifest?.id !== id) throw new Error(`packages/${id}/${id}.js: its manifest's id must be ${id}`);
    for (const name of manifest.files ?? []) if (!existsSync(new URL(`${id}/${name}`, ROOT))) throw new Error(`packages/${id}/: ${name} is in files but missing`);
    packages.push({
      id,
      name: manifest.name,
      description: manifest.description ?? "",
      version: manifest.version ?? "",
      href: `/packages/${id}/${id}.js`,
      permissions: manifest.permissions,
      provides: Object.keys(manifest.provides ?? {}).sort(),
      services: [...(manifest.services ?? [])].sort(),
    });
  }
  // The standard plugins offered too (packages/std.json): they stay in std/, where apps link them, and a
  // person adds them from there, with the files their manifests list (the plugin editor's starting templates
  // come from the folder beside it). Customize isn't offered: the host adds it to every app.
  const STD = new URL("../std/", import.meta.url);
  const { std = [] } = JSON.parse(readFileSync(new URL("std.json", ROOT), "utf8"));
  if (JSON.stringify([...std].sort()) !== JSON.stringify(std)) throw new Error("packages/std.json: list the plugins sorted, one per line");
  for (const id of std) {
    const file = new URL(`${id}.js`, STD);
    if (!ID.test(id) || !existsSync(file)) throw new Error(`packages/std.json: std/${id}.js doesn't exist`);
    const manifest = readManifest(readFileSync(file, "utf8"));
    for (const name of manifest.files ?? []) if (!existsSync(new URL(name, STD))) throw new Error(`std/${id}.js: ${name} is in files but missing`);
    // A person adds it to an app with no slots, so it must say where it draws.
    if (!Object.keys(manifest.places ?? {}).length && manifest.permissions.includes("ui")) throw new Error(`std/${id}.js: offered in the registry, so its manifest needs places, for pages without its slot`);
    packages.push({
      // Its manifest's id, which Customize matches against the person's plugins (std/sync.js is sync-status).
      id: manifest.id,
      name: manifest.name,
      description: manifest.description ?? "",
      version: manifest.version ?? "",
      href: `/std/${id}.js`,
      permissions: manifest.permissions,
      provides: Object.keys(manifest.provides ?? {}).sort(),
      services: [...(manifest.services ?? [])].sort(),
      std: true,
    });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { packages };
}

export const render = (index) => `${JSON.stringify(index, null, 2)}\n`;

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** The registry's page at /packages/: every plugin in the index, and how to add one. Written with the index. */
export function renderPage(index) {
  const byService = new Map(index.packages.flatMap((p) => p.provides.map((s) => [s, p.name])));
  const items = index.packages
    .map((p) => {
      const brings = p.services.filter((s) => byService.has(s)).map((s) => byService.get(s));
      const lines = [
        `      <li id="${escape(p.id)}">`,
        `        <h2><a href="${escape(p.href)}">${escape(p.name)}</a></h2>`,
        `        <p>${escape(p.description)}</p>`,
        `        <p class="meta">Asks for: ${escape(p.permissions.join(", ") || "nothing")}${brings.length ? ` · Brings ${escape(brings.join(", "))}, which it needs` : ""}${p.provides.length ? ` · Provides the ${escape(p.provides.join(", "))} service` : ""}${p.std ? " · A standard plugin" : ""}</p>`,
        `      </li>`,
      ];
      return lines.join("\n");
    })
    .join("\n");
  return `<!doctype html>
<!--
  The plugin registry, as a page. Written by \`npm run packages\` (scripts/packages.mjs) from the same
  manifests as index.json, which Customize reads; don't edit it by hand.
-->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Plugins · Extensible Web Apps</title>
  <meta name="description" content="Plugins anyone can add to any app on this site, from Customize.">
  <link rel="stylesheet" href="/platform/host.css">
  <style>
    .intro { max-width: 75ch; color: var(--fg-2); margin: 0 0 16px; }
    .plugins { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); margin: 0; padding: 0; list-style: none; }
    .plugins li { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); }
    .plugins h2 { font-size: var(--text-lg); margin: 0; }
    .plugins p { margin: 0; color: var(--fg-2); }
    .plugins .meta { font-size: var(--text-sm); }
  </style>
</head>
<body>
  <header>
    <h1>Plugins</h1>
    <nav class="site" aria-label="This site">
      <a href="/">Home</a>
      <a href="/demos/">All demos</a>
      <a href="/packages/" aria-current="page">Plugins</a>
      <a href="/docs/">Docs</a>
      <a href="/workbench/">Workbench</a>
    </nav>
  </header>
  <main>
    <p class="intro">Add any of these to any app, even one whose author never planned for it. Open the app (try the <a href="/demos/trip/app.html">trip</a>), open <strong>Customize</strong> in the bottom left, and pick one under <strong>Add a plugin</strong>. You see its code and what it asks for before it is added, it is kept on your device, and you turn it on when you're ready. A plugin that needs another, as World clock needs Clock, brings it along. <a href="/docs/guide/plugin-registry">How the registry works</a>.</p>
    <ul class="plugins">
${items}
    </ul>
  </main>
</body>
</html>
`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = await buildIndex();
  writeFileSync(new URL("index.json", ROOT), render(index));
  writeFileSync(new URL("index.html", ROOT), renderPage(index));
  console.log(`Wrote packages/index.json (${readFileSync(new URL("index.json", ROOT), "utf8").split("\n").length} lines)`);
}
