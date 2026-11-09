#!/usr/bin/env node
// `extensible-app`: runs, checks and deploys a project of your own, one app
// whose files are at the top of the project, with the platform as a
// dependency (`npm create extensible-app` makes one: scripts/create-app.mjs).
//
//   packing-list/
//     package.json     depends on the platform; its scripts run this command
//     app.html         the app's page: loads /platform/host.js, lists its plugins
//     main.js          a plugin, and anything else the app needs, beside it
//
//   extensible-app dev [--port 5173] [--host 127.0.0.1]   serves the app at http://localhost:5173/
//   extensible-app check [--json]                         the app's mistakes, without a browser
//   extensible-app deploy [--name n] [--replace] [--no-deploy] [--dev]
//                                                         the app on a Cloudflare Worker of its own, at /
//
// What it serves is one site: the platform's built files (dist/ of this
// package, without this repo's own pages: the front page, the demos, the docs)
// at their usual addresses (/platform/, /std/, /elements/, /sw.js and the
// rest), and the project's files at the root, beside them. So the app's own
// address is `/`, and its page is app.html, also served as the front page.
//
// It needs the platform built: an install from GitHub or npm builds it
// (its `prepare` script), and in a checkout of this repo `npm run build && npm run build:server`
// does. It writes only in the project's .extensible/ folder, which is never committed.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SITE_PAGES } from "./deploy-app.mjs";

/** This package: the platform. */
export const PLATFORM = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A project's own files that aren't the app's, and so aren't served. */
const NOT_SERVED = ["node_modules", "package.json", "package-lock.json"];

/** Where the platform's built site is, checked: what a project serves and deploys around its app. */
export function platformSite(platform = PLATFORM) {
  const dist = join(platform, "dist");
  if (!existsSync(join(dist, "platform", "host.js")) || !existsSync(join(platform, ".build", "server", "serve.js")))
    throw new Error(
      platform.split(/[\\/]/).includes("node_modules")
        ? "The platform in node_modules isn't built. Install it again (`npm install`): installing builds it."
        : `The platform at ${platform} isn't built: run \`npm run build && npm run build:server\` there.`,
    );
  return dist;
}

/**
 * What a project's site holds, by name at the root: each of the platform's built files (not this repo's own
 * pages), then each of the project's own. Returns { name: the file or folder it is }. Throws if the project
 * has a top-level file or folder with the same name as one of the platform's, since one address is one file.
 * @param {string} project @param {{ platform?: string }} [options]
 */
export function siteEntries(project, { platform = PLATFORM } = {}) {
  const dist = platformSite(platform);
  if (!existsSync(join(project, "app.html"))) throw new Error(`${relative(process.cwd(), project) || "This folder"} has no app.html: run this in your project's folder`);
  /** @type {Record<string, string>} */
  const entries = {};
  for (const name of readdirSync(dist)) if (!SITE_PAGES.includes(name) && name !== "index.html") entries[name] = join(dist, name);
  for (const name of readdirSync(project)) {
    if (name.startsWith(".") || NOT_SERVED.includes(name)) continue;
    if (entries[name]) throw new Error(`Your project's ${name} has the same address as the platform's /${name}: rename it (the platform's are ${Object.keys(entries).sort().join(", ")})`);
    entries[name] = join(project, name);
  }
  // The front page is the app, unless the project has a front page of its own.
  entries["index.html"] ??= join(project, "app.html");
  return entries;
}

/** Makes `dir` hold a link to each entry, and nothing else: changes to the project's files show at once. */
function linkSite(dir, entries) {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) if (!entries[name]) unlinkSync(join(dir, name));
  for (const [name, target] of Object.entries(entries)) {
    const at = join(dir, name);
    if (existsSync(at) || isLink(at)) unlinkSync(at);
    // A junction needs no special rights on Windows; elsewhere the type is ignored.
    symlinkSync(target, at, lstatSync(target).isDirectory() ? "junction" : "file");
  }
}

const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Serves the project at `/` with the platform around it, and its spaces' server (src/server/serve.ts, built),
 * on this machine. Resolves once it's listening, with its address and a way to stop it.
 * @param {string} project @param {{ port?: number, host?: string, platform?: string, quiet?: boolean }} [options]
 */
export async function dev(project, { port = 5173, host = "127.0.0.1", platform = PLATFORM, quiet = false } = {}) {
  const dir = join(project, ".extensible");
  const site = join(dir, "site");
  linkSite(site, siteEntries(project, { platform }));
  // A file or folder added at the top of the project is served as soon as it's there.
  let timer;
  const watcher = watch(project, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        linkSite(site, siteEntries(project, { platform }));
      } catch (error) {
        if (!quiet) console.error(error.message);
      }
    }, 100);
  });
  const { serve } = await import(pathToFileURL(join(platform, ".build", "server", "serve.js")).href);
  const server = await serve({ port, host, site, spaces: join(dir, "spaces"), kernel: join(platform, ".build", "server", "space.js") });
  return {
    url: `${server.url}/`,
    async stop() {
      watcher.close();
      clearTimeout(timer);
      await server.stop();
    },
  };
}

/** The app's mistakes, as `npm run check` finds them in the repo's demos (scripts/check.mjs). */
export async function check(project) {
  const { checkApps } = await import("./check.mjs");
  const [app] = await checkApps([project]);
  // It names files from the platform's folder; here they're named from the project's.
  const named = (file) => (file ? relative(project, resolve(PLATFORM, file)).split("\\").join("/") : file);
  return { ...app, app: ".", problems: app.problems.map((p) => ({ ...p, file: named(p.file) })) };
}

/**
 * Lays out the project's Worker in .extensible/deploy/: site/, copies of what `dev` serves, and wrangler.jsonc,
 * the platform's own Worker (spaces, accounts, server plugins) with site/ as its assets.
 * @param {string} project @param {{ name?: string, platform?: string }} [options]
 */
export function layoutProject(project, { name, platform = PLATFORM } = {}) {
  const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  const worker = name ?? String(pkg.name ?? "").replace(/^@[^/]+\//, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(worker)) throw new Error(`"${worker}" can't name a Worker: lowercase letters, digits and dashes, at most 63, no dash at either end. Give one with --name.`);
  const target = join(project, ".extensible", "deploy");
  const site = join(target, "site");
  const entries = siteEntries(project, { platform });
  rmSync(target, { recursive: true, force: true });
  mkdirSync(site, { recursive: true });
  for (const [entry, from] of Object.entries(entries)) cpSync(from, join(site, entry), { recursive: true, dereference: true });

  const jsonc = (text) => JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
  const config = jsonc(readFileSync(join(platform, "wrangler.jsonc"), "utf8"));
  const rel = (p) => relative(target, p).split("\\").join("/");
  const appConfig = {
    ...config,
    name: worker,
    main: rel(join(platform, config.main)),
    assets: { ...config.assets, directory: "./site" },
    // Only the app's mark: the platform's own site's variables (its email sender) aren't this project's.
    // Set your own in the Cloudflare dashboard; keep_vars keeps them across deploys.
    vars: { EXTENSIBLE_APP: worker },
  };
  delete appConfig.previews;
  writeFileSync(join(target, "wrangler.jsonc"), `// Written by extensible-app deploy: the platform's Worker serving this project's app at /.\n${JSON.stringify(appConfig, null, 2)}\n`);
  return { target, site, worker, config: join(target, "wrangler.jsonc") };
}

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const USAGE = `Usage, in your project's folder:
  extensible-app dev [--port 5173] [--host 127.0.0.1]
  extensible-app check [--json]
  extensible-app deploy [--name worker-name] [--replace] [--no-deploy] [--dev]`;

// npm runs it through a link in node_modules/.bin, so compare the file the link points at.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  const flag = (f) => (args.includes(f) ? (args.splice(args.indexOf(f), 1), true) : false);
  const option = (f) => {
    const at = args.indexOf(f);
    if (at < 0) return undefined;
    const value = args.splice(at, 2)[1];
    if (!value || value.startsWith("--")) {
      console.error(`${f} needs a value after it`);
      process.exit(2);
    }
    return value;
  };
  const project = process.cwd();
  try {
    if (command === "dev") {
      const port = Number(option("--port") ?? 5173);
      const host = option("--host") ?? "127.0.0.1";
      if (args.length) throw Object.assign(new Error(USAGE), { code: 2 });
      const { url } = await dev(project, { port, host });
      console.log(`Your app is at ${url.replace("127.0.0.1", "localhost")}\nChange its files and reload. Spaces and accounts are kept in .extensible/spaces/.`);
    } else if (command === "check") {
      const json = flag("--json");
      if (args.length) throw Object.assign(new Error(USAGE), { code: 2 });
      const app = await check(project);
      const failed = app.problems.some((p) => p.level === "error");
      if (json) console.log(JSON.stringify({ ok: !failed, apps: [app] }, null, 2));
      else {
        console.log(`${app.problems.length ? "✗" : "✓"} app.html${app.plugins.length ? ` (${app.plugins.join(", ")})` : ""}`);
        for (const p of app.problems) console.log(`    ${p.level.padEnd(7)} ${p.file}${p.line ? `:${p.line}` : ""}  ${p.message}`);
      }
      process.exitCode = failed ? 1 : 0;
    } else if (command === "deploy") {
      const name = option("--name");
      const replace = flag("--replace");
      const noDeploy = flag("--no-deploy");
      const local = flag("--dev");
      if (args.length) throw Object.assign(new Error(USAGE), { code: 2 });
      const laid = layoutProject(project, { name });
      const config = relative(project, laid.config);
      console.log(`Wrote ${relative(project, laid.target)}/ for the Worker "${laid.worker}"`);
      if (local) run("npx", ["wrangler", "dev", "-c", config], project);
      else if (noDeploy) console.log(`Deploy it with: npx wrangler deploy -c ${config}`);
      else {
        // Never over a Worker that isn't this app's, unless asked to (scripts/deploy-guard.mjs).
        const { checkName } = await import("./deploy-guard.mjs");
        console.log(await checkName(laid.worker, laid.worker, { replace }));
        run("npx", ["wrangler", "deploy", "-c", config], project);
        console.log(`Your app is at https://${laid.worker}.<your workers.dev subdomain>/`);
      }
    } else {
      throw Object.assign(new Error(USAGE), { code: 2 });
    }
  } catch (error) {
    console.error(error.message);
    process.exit(error.code === 2 ? 2 : 1);
  }
}
