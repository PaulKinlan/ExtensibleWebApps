// Adds preload hints to every app page in the build (sw/preload-hints.js):
// the files a page's first view needs, named in the page, so the browser asks
// for them as the page arrives and not one after another as each is read.
//
// It also writes /platform/preload.json, what only the build knows about the
// platform's own files: the kernel's and the plugin runtime's built names,
// and the files of each kernel module by the service it gives. A project of
// your own (scripts/extensible-app.mjs) and the service worker (an app made
// in the browser, sw/routes/made.js) read it to hint their own pages.
//
// Pages in the repo are never changed: the hints are made here, into dist/,
// from the files as they are now.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";

type Hints = { withHints(html: string, at: string, read: (path: string) => Promise<string | undefined>, platform?: object): Promise<string> };

/** Every .html file under a folder, as paths from it. */
const pages = (dir: string, under = ""): string[] =>
  readdirSync(join(dir, under), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? (entry.name === "node_modules" ? [] : pages(dir, `${under}${entry.name}/`)) : entry.name.endsWith(".html") ? [`${under}${entry.name}`] : [],
  );

/** What the build knows about the platform's files, from the names it gave them. `code` is a built file's text by its name. */
export function platformFiles(root: string, names: string[], code: (name: string) => string) {
  const host = code("platform/host.js");
  const named = (pattern: RegExp) => {
    const found = pattern.exec(host)?.[0];
    return found && names.includes(found) ? `/${found}` : undefined;
  };
  const modules: Record<string, string[]> = {};
  const std = join(root, "std");
  for (const name of existsSync(std) ? readdirSync(std).sort() : []) {
    const manifest = join(std, name, "module.json");
    if (!existsSync(manifest)) continue;
    const file = names.find((n) => new RegExp(`^assets/kernel-${name}-[\\w-]{8}\\.js$`).test(n));
    // A module with no file of its own starts with every kernel, inside the kernel's file.
    if (!file) continue;
    // And the files it imports that aren't the kernel itself, which the page asks for anyway.
    const imports = [...code(file).matchAll(/\bfrom\s*"\.\/([\w.-]+\.js)"|\bimport\s*"\.\/([\w.-]+\.js)"/g)].map((m) => `assets/${m[1] ?? m[2]}`).filter((n) => names.includes(n) && !/^assets\/browser-/.test(n));
    const files = [file, ...imports].map((n) => `/${n}`);
    for (const service of (JSON.parse(readFileSync(manifest, "utf8")).services ?? []) as string[]) modules[service] = files;
  }
  const kernel = named(/assets\/browser-[\w-]{8}\.js/);
  // The part of the kernel that reads agent files (src/kernel/agents/file.ts), by the name the kernel imports it by.
  const reader = kernel && /import\("\.\/(file-[\w-]{8}\.js)"\)/.exec(code(kernel.slice(1)))?.[1];
  // And the part of the page's script that reads which loop an agent runs (src/shared/agent-runner.ts).
  const agents = [reader && names.includes(`assets/${reader}`) ? `/assets/${reader}` : undefined, named(/assets\/agent-runner-[\w-]{8}\.js/)].filter((file): file is string => !!file);
  return { kernel, runtime: named(/assets\/runtime-[\w-]{8}\.js/), netRuntime: named(/assets\/net-runtime-[\w-]{8}\.js/), agents, modules };
}

export function preloadHints(): Plugin {
  let outDir = "dist";
  let root = process.cwd();
  return {
    name: "preload-hints",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      root = config.root;
    },
    async writeBundle(_options, bundle) {
      const text = (name: string) => {
        const file = bundle[name];
        return !file ? "" : file.type === "chunk" ? file.code : String(file.source);
      };
      const platform = platformFiles(root, Object.keys(bundle), text);
      if (!platform.kernel || !platform.runtime) throw new Error("The build's page script doesn't name the kernel and the plugin runtime as vite.preload.ts reads them, so no page can be given its preload hints");
      writeFileSync(join(outDir, "platform", "preload.json"), `${JSON.stringify(platform, null, 1)}\n`);
      const { withHints } = (await import(pathToFileURL(join(root, "sw/preload-hints.js")).href)) as Hints;
      const read = async (path: string) => {
        const file = resolve(outDir, `.${decodeURIComponent(path)}`);
        return file.startsWith(outDir + sep) && existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : undefined;
      };
      for (const page of pages(outDir)) {
        const file = join(outDir, page);
        const html = readFileSync(file, "utf8");
        const hinted = await withHints(html, `/${page}`, read, platform);
        if (hinted !== html) writeFileSync(file, hinted);
      }
    },
  };
}
