// Deploys one app as a Worker of its own, on its own origin: the platform
// (the host, the kernel, the standard plugins, the service worker, the
// space server) plus that one app, and nothing else from this site.
//
//   npm run deploy:app -- demos/habits                   builds, then deploys to https://habits.<you>.workers.dev
//   npm run deploy:app -- demos/habits --name my-habits  the Worker's name, and so its address
//   npm run deploy:app -- demos/habits --replace         deploys even over a Worker by that name that isn't this app's
//   npm run deploy:app -- demos/habits --no-deploy       builds and writes the config, deploys nothing
//   npm run deploy:app -- demos/habits --dev             runs it on this machine with `wrangler dev`
//
// What it writes, in .build/apps/<name>/ (never committed):
//
//   site/            what the Worker serves: dist/ without this site's own
//                    pages (everything in site/, plus demos/, docs/ and starter/),
//                    the app's folder at the same path it has
//                    here, the folders its app.html links with ../, and an
//                    index.html that is the app's page, so / is the app
//   wrangler.jsonc   the root wrangler.jsonc with a new name and site/ as its
//                    assets: the same Worker code, Durable Objects (spaces,
//                    accounts) and Dynamic Workers (server plugins), and the
//                    app's path as the variable EXTENSIBLE_APP
//
// The app's files keep their path (/demos/habits/), so nothing in them is
// rewritten. The Worker's front page is the app's own page with a <base>
// naming that folder, as the service worker serves an app's screens
// (sw/routes/apps.js): its relative links resolve as they do here, and the
// address people open and share is the Worker's own, with no /demos/habits/.
//
// Before deploying it checks the account (scripts/deploy-guard.mjs): a Worker
// with the same name is replaced only if this script deployed it, for this
// app. Any other Worker by that name is left alone, and the deploy refused,
// unless --replace says to replace it.
//
// Every origin is a world of its own: its own service worker, shared-worker
// kernel and browser storage, its own accounts and passkeys (a passkey is
// bound to the host name), its own spaces. Nothing is shared with the main
// site or with another app's Worker.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_VAR, checkName } from "./deploy-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** dist/'s pages that are this site's own, not the platform's: an app's Worker doesn't serve them. */
export const SITE_PAGES = [
  // site/ is this website's own pages (the front page, home/, workbench/), served at the root.
  ...readdirSync(join(ROOT, "site")).filter((name) => !name.startsWith(".")),
  "demos",
  "docs",
  "starter",
  "llms.txt",
];

/** The platform's own top-level folders in dist/: an app can't live at one of these paths. */
export const PLATFORM_FOLDERS = ["platform", "assets", "std", "elements", "sw", "account", "vendor", "auth", "s", "user"];

/** An attribute's value, quoted or not (`href=../shared/plugin.js` is valid HTML, and the host reads it). */
const VALUE = String.raw`\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`;
const values = (html, attr) => [...html.matchAll(new RegExp(`\\b(?:${attr})${VALUE}`, "gi"))].map((m) => (m[1] ?? m[2] ?? m[3]).split(/[#?]/)[0]);

/** Top-level paths an app may link to absolutely and still find on its own Worker (checked against site/). */
const linksIn = (html) => values(html, "href|src").filter((v) => v.startsWith("/") && !v.startsWith("//"));

/** Reads JSONC: the root wrangler.jsonc has comments, but no comment markers inside its strings. */
const jsonc = (text) => JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * Lays out an app's Worker from a built dist/. Returns where it wrote, the app's path on the site, and
 * warnings: absolute links in app.html to pages the Worker won't have.
 * @param {string} app the app's folder (or its app.html)
 * @param {{ name?: string, dist?: string, out?: string }} [options]
 */
export function layoutApp(app, { name, dist = join(ROOT, "dist"), out } = {}) {
  const folder = resolve(app.endsWith(".html") ? dirname(app) : app);
  const page = join(folder, "app.html");
  if (!existsSync(page)) throw new Error(`${relative(process.cwd(), folder) || folder} has no app.html`);
  if (!existsSync(join(dist, "platform", "host.js"))) throw new Error("dist/ isn't built: run `npm run build` first");
  const worker = name ?? basename(folder);
  // Cloudflare's rule for a Worker's name, which is also the first label of its workers.dev address.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(worker)) throw new Error(`"${worker}" can't name a Worker: lowercase letters, digits and dashes, at most 63, no dash at either end. Give one with --name.`);

  // Inside this repo the app keeps its path; outside it, it goes at /<folder name>/. Either way,
  // `base` is the folder that maps to the site's root, so the app's ../ links land where they did.
  const inside = relative(ROOT, folder);
  const base = inside && !inside.startsWith("..") ? ROOT : dirname(folder);
  const onSite = (p) => relative(base, p).split("\\").join("/");
  const path = onSite(folder);
  const top = path.split("/")[0];
  if (PLATFORM_FOLDERS.includes(top)) throw new Error(`/${path}/ is inside the platform's own /${top}/: move the app into a folder of its own`);

  const target = out ?? join(ROOT, ".build", "apps", worker);
  const site = join(target, "site");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(site, { recursive: true });
  // The app's own top folder comes from its source below (a top-level folder here is copied into dist/ too).
  for (const entry of readdirSync(dist)) if (!SITE_PAGES.includes(entry) && entry !== top) cpSync(join(dist, entry), join(site, entry), { recursive: true });

  // The app's own files as written (they're copied unchanged into dist/ too), and each folder it links
  // with ../ (a plugin another app owns: ../reading-list/library.js), at their paths beside it.
  const copyFolder = (from, to) => cpSync(from, join(site, to), { recursive: true, filter: (f) => !basename(f).startsWith(".") && basename(f) !== "node_modules" });
  copyFolder(folder, path);
  const html = readFileSync(page, "utf8");
  for (const href of values(html, "href|src").filter((v) => v.startsWith("../"))) {
    const linked = resolve(folder, href);
    const its = onSite(dirname(linked));
    // A link above the site's root has nowhere to go on the Worker: refuse, rather than deploy an app missing a plugin.
    if (!its || its.startsWith("..")) throw new Error(`app.html links ${href}, which is outside ${relative(process.cwd(), base) || "."}/ and so can't be served beside the app`);
    if (PLATFORM_FOLDERS.includes(its.split("/")[0])) throw new Error(`app.html links ${href}, inside the platform's own /${its.split("/")[0]}/`);
    if (!existsSync(linked)) continue; // npm run check reports a missing file
    if (!existsSync(join(site, onSite(linked)))) copyFolder(dirname(linked), its);
  }

  // The main site's navigation (<nav class="site">: Home, All demos, Docs, Workbench) points at pages this
  // Worker doesn't have, so the deployed copy of app.html leaves it out. The app's own files are untouched.
  // A <nav> whose class attribute has the token `site` (not site-tools, not data-class="site").
  const served = html.replace(/\s*<nav\b([^>]*)>[\s\S]*?<\/nav>/gi, (whole, attrs) => {
    const cls = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
    const tokens = cls ? (cls[1] ?? cls[2] ?? cls[3]).split(/\s+/) : [];
    return tokens.includes("site") ? "" : whole;
  });
  if (served !== html) writeFileSync(join(site, path, "app.html"), served);

  // The front page is the app: its page, with a <base> naming its folder, so its relative links (plugins,
  // templates, screens) resolve there. A plain file, not a Worker route, so the Worker's code stays the
  // platform's own, and it works under any static host too.
  const baseTag = `<!-- This Worker serves one app, /${escapeHtml(path)}/, here at / too (scripts/deploy-app.mjs). -->\n  <base href="/${escapeHtml(path)}/">`;
  const front = /<head\b[^>]*>/i.test(served) ? served.replace(/<head\b[^>]*>/i, (head) => `${head}\n  ${baseTag}`) : `${baseTag}${served}`;
  writeFileSync(join(site, "index.html"), front);

  // Links in the deployed app.html to pages this Worker won't have.
  const warnings = [];
  for (const href of new Set(linksIn(served))) {
    if (href === "/") continue;
    const file = join(site, href);
    const served = (existsSync(file) && statSync(file).isFile()) || existsSync(join(file, "index.html")) || existsSync(join(file, "app.html"));
    if (!served) warnings.push(`app.html links to ${href}, which this Worker doesn't serve`);
  }

  // The site's own Worker config with a new name and these assets. Paths are relative to the new config's folder.
  const config = jsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
  const rel = (p) => relative(target, p).split("\\").join("/");
  const appConfig = {
    ...config,
    name: worker,
    main: rel(join(ROOT, config.main)),
    assets: { ...config.assets, directory: "./site" },
    // Which app this Worker serves, so a later deploy can tell it from a Worker that isn't this app's (deploy-guard.mjs).
    // The site's sign-in providers stay behind: their callback is the site's host and their secrets the site's
    // Worker's, so this Worker would refuse to start its accounts. An app sets up its own (docs/guide/deploying-an-app.md).
    vars: { ...Object.fromEntries(Object.entries(config.vars ?? {}).filter(([name]) => name !== "AUTH_PROVIDERS")), [APP_VAR]: path },
  };
  writeFileSync(
    join(target, "wrangler.jsonc"),
    `// Written by scripts/deploy-app.mjs: the platform's Worker (${config.main}) serving one app, /${path}/.\n// Deploy: npx wrangler deploy -c ${relative(ROOT, join(target, "wrangler.jsonc"))}\n${JSON.stringify(appConfig, null, 2)}\n`,
  );
  return { target, site, path, worker, warnings };
}

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (f) => (args.includes(f) ? (args.splice(args.indexOf(f), 1), true) : false);
  const nameAt = args.indexOf("--name");
  const name = nameAt >= 0 ? args.splice(nameAt, 2)[1] : undefined;
  if (nameAt >= 0 && (!name || name.startsWith("--"))) {
    console.error("--name needs the Worker's name after it");
    process.exit(2);
  }
  const replace = flag("--replace");
  const noBuild = flag("--no-build");
  const noDeploy = flag("--no-deploy");
  const dev = flag("--dev");
  if (args.length !== 1) {
    console.error("Usage: npm run deploy:app -- <app folder> [--name worker-name] [--replace] [--no-build] [--no-deploy] [--dev]");
    process.exit(2);
  }
  if (!noBuild) run("npm", ["run", "build"]);
  let laid;
  try {
    laid = layoutApp(args[0], { name });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  for (const w of laid.warnings) console.log(`warning  ${w}`);
  const config = relative(ROOT, join(laid.target, "wrangler.jsonc"));
  console.log(`Wrote ${relative(ROOT, laid.target)}/ for the Worker "${laid.worker}", serving /${laid.path}/`);
  if (dev) run("npx", ["wrangler", "dev", "-c", config]);
  else if (noDeploy) console.log(`Deploy it with: npx wrangler deploy -c ${config}`);
  else {
    // Never over a Worker that isn't this app's, unless asked to.
    try {
      const said = await checkName(laid.worker, laid.path, { replace });
      console.log(said);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    run("npx", ["wrangler", "deploy", "-c", config]);
    console.log(`Open https://${laid.worker}.<your workers.dev subdomain>/ (the app is at / and at /${laid.path}/)`);
  }
}
