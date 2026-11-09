#!/usr/bin/env node
// What is in the files every page downloads, and how much each part weighs:
//
//   npm run sizes            the kernel's own file (assets/browser.js)
//   npm run sizes -- host    the page's script (platform/host.js)
//   npm run sizes -- all     every file the build makes, one line each
//
// The kernel stays small (docs/layers.md): this is how to see what a change
// added to it, and what could be fetched on demand instead. It builds into a
// folder of its own, so dist/ is left alone. Each part is minified and
// gzipped by itself, so the parts add up to a little more than the file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { transformSync } from "esbuild";
import { build, loadConfigFromFile } from "vite";

const what = process.argv[2] ?? "kernel";
const chunks = {};
const report = () => ({
  name: "sizes",
  generateBundle(_options, bundle) {
    for (const [file, chunk] of Object.entries(bundle)) if (chunk.type === "chunk") chunks[file] = { gzip: gzipSync(chunk.code).length, modules: Object.fromEntries(Object.entries(chunk.modules).map(([id, m]) => [id, m.code ?? ""])) };
  },
});
const { config } = await loadConfigFromFile({ command: "build", mode: "production" }, "vite.config.ts");
const out = mkdtempSync(join(tmpdir(), "sizes-"));
const workerPlugins = config.worker.plugins;
await build({ ...config, configFile: false, logLevel: "warn", build: { ...config.build, outDir: out, emptyOutDir: true }, plugins: [...config.plugins, report()], worker: { ...config.worker, plugins: () => [...workerPlugins(), report()] } });
rmSync(out, { recursive: true, force: true });

const kb = (bytes) => (bytes / 1024).toFixed(1).padStart(7);
if (what === "all") {
  for (const [file, chunk] of Object.entries(chunks).sort((a, b) => b[1].gzip - a[1].gzip)) console.log(`${kb(chunk.gzip)} KB  ${file}`);
} else {
  const pattern = what === "host" ? /^platform\/host\.js$/ : /^assets\/browser-/;
  const [file, chunk] = Object.entries(chunks).find(([name]) => pattern.test(name)) ?? [];
  if (!chunk) throw new Error(`The build made no file for ${what}`);
  // A part is a file, or for a package or a kernel module's folder, all of its files.
  const part = (id) => {
    const path = id.replace(process.cwd() + "/", "").replace(/\?.*$/, "");
    const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path);
    return pkg ? `(package) ${pkg[1]}` : (/^std\/[^/]+/.exec(path)?.[0] ?? path);
  };
  const parts = {};
  for (const [id, code] of Object.entries(chunk.modules)) (parts[part(id)] ??= []).push(code);
  const rows = Object.entries(parts)
    .map(([name, codes]) => [name, gzipSync(transformSync(codes.join("\n"), { minify: true, loader: "js" }).code).length])
    .filter(([, bytes]) => bytes > 20)
    .sort((a, b) => b[1] - a[1]);
  for (const [name, bytes] of rows) console.log(`${kb(bytes)} KB  ${name}`);
  console.log(`\n${kb(chunk.gzip)} KB  ${file}, gzipped, as the browser downloads it`);
}
