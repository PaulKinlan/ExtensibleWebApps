#!/usr/bin/env node
// What every app pays before its first view is on the page, measured from the build in dist/:
//
//   npm run first-draw                         every demo and the front page
//   npm run first-draw -- demos/habits/        only the apps named
//   npm run first-draw -- --json out.json      also write the numbers to a file
//   npm run first-draw -- --against base.json  and say what changed since those numbers (main's, on a pull request)
//   npm run first-draw -- --dist other/dist    measure another build (main's, checked out beside this one)
//   npm run first-draw -- --runs 3             open each app three times and report the middle time
//
// For each app it opens the page twice in a fresh browser profile, as a visitor would:
//
//   - a first visit, with nothing kept: which files were asked for before the first plugin view was in the
//     page, how much they weigh gzipped, and how long it took
//   - the next visit, answered by the service worker: how long it took
//
// The site is served from this machine, where a request takes no time, so every response is held back by one
// round trip (--rtt, 100 ms unless said). That makes the time say how many requests had to follow one another
// before the first view: a file the page can only ask for after another has arrived costs a round trip, however
// small it is. The server speaks HTTP/2 over TLS, as a real host does, so requests aren't queued six at a time.
//
// It never fails on a size or a time. Growth is printed as a warning (and on GitHub Actions shown on the pull
// request and in the run's summary): the answer to growth is a change to the architecture, not a red build
// (docs/layers.md, "The kernel stays small").
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { headerRules } from "../src/server/header-rules.ts";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? fallback : args.splice(at, 2)[1];
};
const RTT = Number(option("rtt", 100));
const RUNS = Number(option("runs", 1));
const jsonOut = option("json");
/** Only the numbers file: no report, and no warnings (a run that measures what another is compared against). */
const numbersOnly = args.includes("--quiet") && !!args.splice(args.indexOf("--quiet"), 1);
const against = option("against");
const DIST = resolve(option("dist", "dist"));
if (!existsSync(join(DIST, "platform/host.js"))) throw new Error(`There is no build in ${DIST}: run npm run build first`);

/** The apps measured: the ones named, or every demo and the front page. */
const apps = args.length
  ? args.map((a) => a.replace(/^\/+/, "").replace(/\/?$/, "/"))
  : ["", ...readdirSync(join(DIST, "demos")).filter((d) => existsSync(join(DIST, "demos", d, "app.html"))).map((d) => `demos/${d}/`)];

// ---- The server: dist/ as a host serves it, each response one round trip late ----

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".md": "text/markdown", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".webmanifest": "application/manifest+json" };
const rules = headerRules(join(DIST, "_headers"));
const tmp = mkdtempSync(join(tmpdir(), "first-draw-"));
// A certificate for this run only. The browser is told its key (below), so it treats the site as any https one: service worker, cache and all.
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(tmp, "key.pem"), "-out", join(tmp, "cert.pem"), "-days", "2", "-subj", "/CN=first-draw.localhost", "-addext", "subjectAltName=DNS:first-draw.localhost"], { stdio: "ignore" });
const cert = readFileSync(join(tmp, "cert.pem"));
const spki = createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");

/** Every request the server got, in order: when, and for what. */
let log = [];
const gz = new Map();
/** A file's size as a host sends it. */
const gzipped = (file) => gz.get(file) ?? gz.set(file, gzipSync(readFileSync(file)).length).get(file);
const fileFor = (path) => {
  const file = resolve(DIST, `.${path}`);
  if (file !== DIST && !file.startsWith(DIST + sep)) return undefined;
  if (existsSync(file) && statSync(file).isFile()) return file;
  const index = join(file, "index.html");
  return existsSync(index) ? index : undefined;
};
const server = createSecureServer({ key: readFileSync(join(tmp, "key.pem")), cert, allowHTTP1: true }, (req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, "https://first-draw.localhost").pathname);
  } catch {
    return void res.writeHead(400).end();
  }
  const file = fileFor(path) ?? (String(req.headers.accept ?? "").includes("text/html") && !path.split("/").pop().includes(".") ? join(DIST, "404.html") : undefined);
  log.push({ at: Date.now(), path, dest: req.headers["sec-fetch-dest"], bytes: file && fileFor(path) ? gzipped(file) : 0 });
  setTimeout(() => {
    if (!file) return void res.writeHead(404).end();
    const headers = { "content-type": TYPES[extname(file)] ?? "application/octet-stream" };
    for (const rule of rules) if (rule.path.test(path)) Object.assign(headers, Object.fromEntries(Object.entries(rule.headers).map(([k, v]) => [k.toLowerCase(), v])));
    res.writeHead(fileFor(path) ? 200 : 404, headers);
    res.end(readFileSync(file));
  }, RTT);
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const SITE = `https://first-draw.localhost:${server.address().port}/`;

// ---- The measuring ----

/** What a file is to an app, by its address: the rows of the report. */
const KINDS = [
  ["kernel", /^\/assets\/browser-/],
  ["kernel modules", /^\/assets\/kernel-/],
  ["plugin runtime", /^\/assets\/(net-)?runtime-/],
  ["kernel and page parts", /^\/assets\//],
  ["page script", /^\/platform\/.*\.js$/],
  ["page styles", /^\/platform\/.*\.css$/],
  ["elements", /^\/elements\//],
  ["standard plugins", /^\/std\//],
  ["service worker", /^\/sw(\.js$|\/)/],
];
const kindOf = (path) => KINDS.find(([, pattern]) => pattern.test(path))?.[0] ?? "the app's own files";
const kb = (bytes) => Math.round(bytes / 102.4) / 10;
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
/** Settles once the server has heard nothing for `ms`: the page and its workers have what they asked for. */
const quiet = async (ms = 700) => {
  for (;;) {
    const last = log.at(-1)?.at ?? 0;
    if (Date.now() - last > ms) return;
    await new Promise((r) => setTimeout(r, 100));
  }
};

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP first-draw.localhost 127.0.0.1", `--ignore-certificate-errors-spki-list=${spki}`] });
/** The first view a plugin of the app drew: Customize's button, which the host adds to every app, isn't the app's. */
const VIEW = '[data-key]:not([data-key^="customize:"])';

/** Runs in the page before anything else: notes when the first plugin view is in the page, on the page's own clock. */
const watch = (view) => {
  const seen = () => {
    if (window.__firstView === undefined && document.querySelector(view)) window.__firstView = performance.now();
  };
  new MutationObserver(seen).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-key"] });
};
/** When the first view was in the page, in ms since the navigation started, and that start on the server's clock. */
const firstView = async (page) => {
  await page.waitForFunction(() => window.__firstView !== undefined, null, { timeout: 20000 });
  return page.evaluate(() => ({ ms: Math.round(window.__firstView), started: performance.timeOrigin }));
};

async function measure(app) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await context.addInitScript(watch, VIEW);
    const page = await context.newPage();
    log = [];
    // A first visit: a folder's address is answered by 404.html, which starts the service worker, so it is timed at app.html.
    await page.goto(`${SITE}${app}${app === "" ? "" : "app.html"}`, { waitUntil: "commit" });
    const drawn = await firstView(page).catch(() => undefined);
    if (!drawn) return { failed: "no plugin view was in the page after 20 s" };
    // The service worker's own files are asked for while the page loads, but nothing waits for them.
    const before = log.filter((r) => r.at <= drawn.started + drawn.ms && r.dest !== "serviceworker");
    const seen = new Set();
    const files = before.filter((r) => r.bytes && !seen.has(r.path) && seen.add(r.path));
    const by = {};
    for (const file of files) by[kindOf(file.path)] = (by[kindOf(file.path)] ?? 0) + file.bytes;
    const first = { ms: drawn.ms, requests: files.length, kb: kb(files.reduce((sum, f) => sum + f.bytes, 0)), by: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, kb(v)])), files: files.map((f) => [Math.round(f.at - drawn.started), f.path]) };
    await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 }).catch(() => {});
    await quiet(2500);
    const modules = await page.evaluate(() => window.__host?.command("modules")).catch(() => undefined);
    await page.close();
    // The next visit, at the folder's address, the service worker answering.
    const next = await context.newPage();
    await next.goto(`${SITE}${app}`, { waitUntil: "commit" });
    const again = await firstView(next).then((v) => v.ms, () => null);
    return { first, again: { ms: again }, modules: Array.isArray(modules) ? modules.filter((m) => m.running).map((m) => m.name) : [] };
  } finally {
    await context.close();
  }
}

const results = {};
for (const app of apps) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await measure(app));
  const good = runs.filter((r) => !r.failed);
  const name = app || "/";
  if (!good.length) results[name] = runs[0];
  else {
    // Each time is the middle one of the runs; the files are the first run's (they don't change between runs).
    results[name] = { ...good[0], first: { ...good[0].first, ms: median(good.map((r) => r.first.ms)) }, again: { ms: median(good.map((r) => r.again.ms ?? Infinity)) } };
  }
  const r = results[name];
  console.log(r.failed ? `${name}: ${r.failed}` : `${name}: first view ${r.first.ms} ms after ${r.first.requests} files (${r.first.kb} KB); next visit ${r.again.ms} ms`);
}
await browser.close();
server.close();
rmSync(tmp, { recursive: true, force: true });

/** The platform's own files, by their names without the hash: what every app, or any app that uses the part, downloads. */
const platform = {};
for (const folder of ["platform", "assets"])
  for (const file of readdirSync(join(DIST, folder)).filter((f) => /\.(js|css)$/.test(f)))
    platform[`${folder}/${file.replace(/-[\w-]{8}\.(js|css)$/, ".$1")}`] = kb(gzipped(join(DIST, folder, file)));

const report = { rttMs: RTT, platform, apps: results };
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));

// ---- The report ----

const lines = [];
const base = against && existsSync(against) ? JSON.parse(readFileSync(against, "utf8")) : undefined;
const warnings = [];
const delta = (now, was, unit) => (was === undefined || was === null || now === was ? "" : ` (${now > was ? "+" : "−"}${Math.round(Math.abs(now - was) * 10) / 10} ${unit})`);
lines.push(`### What each app pays before its first view`, "", `Each response is held back ${RTT} ms (one round trip), so the times count the requests that had to follow one another.${base ? " Changes are against main." : ""}`, "");
lines.push("| App | Files | KB gzipped | First view, first visit | First view, next visit | Kernel modules started |", "| --- | ---: | ---: | ---: | ---: | --- |");
for (const [name, r] of Object.entries(results)) {
  if (r.failed) {
    lines.push(`| ${name} | | | ${r.failed} | | |`);
    warnings.push(`${name}: ${r.failed}`);
    continue;
  }
  const was = base?.apps?.[name];
  lines.push(`| ${name} | ${r.first.requests}${delta(r.first.requests, was?.first?.requests, "")} | ${r.first.kb}${delta(r.first.kb, was?.first?.kb, "KB")} | ${r.first.ms} ms${delta(r.first.ms, was?.first?.ms, "ms")} | ${r.again.ms} ms${delta(r.again.ms, was?.again?.ms, "ms")} | ${r.modules.join(", ")} |`);
  if (was?.first) {
    // A round trip more is a request that now waits on another: the pattern to look for.
    if (r.first.ms > was.first.ms + RTT * 0.8) warnings.push(`${name}'s first view takes ${r.first.ms} ms on a first visit, up from ${was.first.ms} ms on main: a request now waits on another`);
  }
}
// One app's bytes by part: Habits, the smallest complete demo, when it was measured.
const sampled = results["demos/habits/"]?.first ? "demos/habits/" : Object.keys(results).find((k) => !results[k].failed);
const sample = sampled && results[sampled];
if (sample) {
  lines.push("", `Where ${sampled}'s bytes go:`, "", "| Part | KB gzipped |", "| --- | ---: |");
  for (const [kind, size] of Object.entries(sample.first.by).sort((a, b) => b[1] - a[1])) lines.push(`| ${kind} | ${size} |`);
}
lines.push("", "### The platform's files", "", "| File | KB gzipped |", "| --- | ---: |");
const names = new Set([...Object.keys(platform), ...Object.keys(base?.platform ?? {})]);
for (const name of [...names].sort((a, b) => (platform[b] ?? 0) - (platform[a] ?? 0))) {
  const now = platform[name];
  const was = base?.platform?.[name];
  if (now === undefined) lines.push(`| ${name} | gone (was ${was}) |`);
  else lines.push(`| ${name} | ${now}${base ? (was === undefined ? " (new)" : delta(now, was, "KB")) : ""} |`);
  // The two files every app downloads whole: growth here is what the rule is about.
  if (was !== undefined && now > was + 0.1 && /^(assets\/browser|platform\/host)\.js$/.test(name)) warnings.push(`${name} is ${now} KB gzipped, up from ${was} KB on main: find what can load on demand instead (docs/layers.md)`);
}
if (numbersOnly) process.exit(0);
console.log(`\n${lines.join("\n")}`);
for (const warning of warnings) console.log(process.env.GITHUB_ACTIONS ? `::warning title=Size and speed::${warning}` : `WARN  ${warning}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n${warnings.length ? `\n${warnings.map((w) => `- ⚠️ ${w}`).join("\n")}\n` : ""}`);
