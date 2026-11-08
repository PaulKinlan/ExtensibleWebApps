// The plugin registry's index (packages/index.json, served at
// /packages/index.json): one entry per package, sorted by id, read from each
// plugin's manifest. A package is a folder packages/<id>/ holding <id>.js and
// the files its manifest lists. Customize lists the index, so a person can add
// any of them to an app (docs/guide/plugin-registry.md).
//
//   npm run packages    rewrites packages/index.json (the tests check it is current)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = new URL("../packages/", import.meta.url);
const ID = /^[a-z][a-z0-9-]{0,63}$/;

/** The kernel's own manifest reader, bundled from src/ (as scripts/check.mjs does): it reads the manifest literal without running the plugin. */
async function manifestReader() {
  const out = await build({
    stdin: { contents: 'export { readManifest } from "./src/kernel/manifest.ts";', resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`)).readManifest;
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
  return { packages };
}

export const render = (index) => `${JSON.stringify(index, null, 2)}\n`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(new URL("index.json", ROOT), render(await buildIndex()));
  console.log(`Wrote packages/index.json (${readFileSync(new URL("index.json", ROOT), "utf8").split("\n").length} lines)`);
}
