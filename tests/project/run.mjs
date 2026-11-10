// A project of your own, end to end, as someone who has never seen this repo
// gets it: from the two npm packages, on whatever system this runs on. No
// browser. The "Project checks" workflow runs it on Linux and on Windows.
//
//   npm run test:project        (after npm run build && npm run build:server)
//
// It packs both packages as `npm publish` would send them (scripts/release.mjs,
// then npm pack), then, in a folder outside the repo:
//
//   1. runs the create command from its package, which runs the platform's
//      from its package, and installs the project's dependencies
//   2. `npm run check`, with and without a kernel.json of the project's own
//   3. `npm run deploy -- --no-deploy`, then has wrangler bundle the Worker it
//      wrote without deploying it, with the project's kernel in it
//   4. `extensible-app dev`: the app at /, its files, the platform's, the
//      project's kernel.json in the browser's kernel, and nothing that
//      shouldn't be served
//
// It needs the network, for the project's `npm install`. The repo's
// package.json files are put back as they were whatever happens.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepare } from "../../scripts/release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WINDOWS = process.platform === "win32";
const VERSION = "0.0.1-check.0";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${String(detail).slice(-1500)})`}`);
}

/** Runs npm (or npx) and waits. npm is a .cmd on Windows, which needs a shell: every argument here is plain, or quoted for it. */
function npm(args, cwd, { command = "npm", env = {} } = {}) {
  const result = WINDOWS
    ? spawnSync(`${command}.cmd`, args.map((a) => (/[\s"&|<>^]/.test(a) ? JSON.stringify(a) : a)), { cwd, encoding: "utf8", shell: true, env: { ...process.env, ...env } })
    : spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout ?? "", out: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? result.error.message : ""}` };
}

/** Packs a package as it is now, into `to`. Returns the tarball. The platform is already built, so nothing is built again. */
function pack(folder, to) {
  const packed = npm(["pack", "--ignore-scripts", "--pack-destination", to, "--json"], folder);
  if (packed.status !== 0) throw new Error(`npm pack failed in ${folder}: ${packed.out.slice(-800)}`);
  const [{ filename }] = JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[")));
  return join(to, filename.replace(/^@/, "").replace("/", "-"));
}

const freePort = () =>
  new Promise((done, failedToListen) => {
    const server = createServer();
    server.once("error", failedToListen);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

if (!existsSync(join(ROOT, "dist/platform/host.js")) || !existsSync(join(ROOT, ".build/server/serve.js")) || !existsSync(join(ROOT, ".build/cloudflare/kernel-source.js"))) {
  console.error("The platform isn't built: run `npm run build && npm run build:server` first.");
  process.exit(1);
}

// realpath: on macOS and Windows the temporary folder's name isn't always the one the system reports back.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "project-check-")));
const packageFiles = ["package.json", "scripts/create-extensible-app/package.json"].map((file) => join(ROOT, file));
const before = packageFiles.map((file) => readFileSync(file, "utf8"));
let devServer;
try {
  // ---- The two packages, as npm would serve them ----
  let tarballs;
  try {
    const [platform, create] = prepare(VERSION);
    tarballs = { platform: pack(platform.folder, scratch), create: pack(create.folder, scratch) };
  } finally {
    packageFiles.forEach((file, i) => writeFileSync(file, before[i]));
  }
  check("the repo's package.json files are as they were after packing", packageFiles.every((file, i) => readFileSync(file, "utf8") === before[i]));
  const listed = npm(["pack", "--dry-run", "--ignore-scripts", "--json"], ROOT);
  const files = listed.status === 0 ? JSON.parse(listed.stdout.slice(listed.stdout.indexOf("["))).flatMap((p) => p.files.map((f) => f.path)) : [];
  const has = (path) => files.includes(path);
  check(
    "the platform's package has what a project runs (the built site, both server kernels, the commands, the starter) and none of this site's own built pages or tests",
    has("dist/platform/host.js") && has("dist/sw.js") && has(".build/server/serve.js") && has(".build/server/space.js") && has(".build/cloudflare/kernel-source.js") && has("scripts/extensible-app.mjs") && has("scripts/project-kernel.mjs") && has("starter/app.html") && has("kernel.json") && has("vite.kernel-modules.ts") && has("wrangler.jsonc") && has("LICENSE") &&
      !files.some((f) => f.startsWith("dist/demos/") || f.startsWith("tests/") || f.startsWith("node_modules/") || f.startsWith(".github/") || f === "dist/index.html"),
    `${files.length} files; ${listed.out.slice(-300)}`,
  );

  // ---- 1. npm create extensible-app, from the packages ----
  // The create command's package runs the platform's own, from the platform's package; the project then depends on that same package.
  const made = npm(["exec", "--yes", "--package", tarballs.create, "--", "create-extensible-app", "packing-list", "--name", "Packing list", "--platform", `file:${tarballs.platform.split("\\").join("/")}`], scratch, { env: { CREATE_EXTENSIBLE_APP_FROM: tarballs.platform } });
  const project = join(scratch, "packing-list");
  const inProject = (path) => existsSync(join(project, path));
  check("the create command makes the project and installs the platform into it", made.status === 0 && inProject("app.html") && inProject("main.js") && inProject("node_modules/extensible-web-apps/dist/platform/host.js"), made.out);
  const installed = inProject("node_modules/extensible-web-apps/package.json") ? JSON.parse(readFileSync(join(project, "node_modules/extensible-web-apps/package.json"), "utf8")) : {};
  check("what it installed is the published kind of package: versioned, not private, already built", installed.version === VERSION && installed.private === undefined && inProject("node_modules/extensible-web-apps/.build/server/serve.js"), JSON.stringify({ version: installed.version, private: installed.private }));
  if (!inProject("node_modules/extensible-web-apps/scripts/extensible-app.mjs")) throw new Error("The project has no platform to run: the rest can't be checked.");

  // A copy from npm makes projects that depend on it by version, so they install built and `npm update` moves them on.
  const byVersion = spawnSync(process.execPath, [join(project, "node_modules/extensible-web-apps/scripts/create-app.mjs"), "from-npm", "--no-install"], { cwd: scratch, encoding: "utf8" });
  const fromNpm = existsSync(join(scratch, "from-npm/package.json")) ? JSON.parse(readFileSync(join(scratch, "from-npm/package.json"), "utf8")) : {};
  check("a platform that came from npm makes projects that depend on its own version", byVersion.status === 0 && fromNpm.dependencies?.["extensible-web-apps"] === `^${VERSION}`, `${byVersion.stderr} ${JSON.stringify(fromNpm.dependencies)}`);

  // ---- 2. npm run check ----
  const checked = npm(["run", "check"], project);
  check("npm run check passes the new project", checked.status === 0 && /app\.html \(packing-list/.test(checked.out), checked.out);
  writeFileSync(join(project, "kernel.json"), JSON.stringify({ modules: ["debug", "teleport"] }));
  const refused = npm(["run", "check"], project);
  check("npm run check refuses a kernel.json naming a module the platform hasn't got", refused.status !== 0 && /teleport/.test(refused.out), refused.out);
  writeFileSync(join(project, "kernel.json"), JSON.stringify({ modules: ["debug", "router"], hooks: { max: 3 } }, null, 2));
  const checkedOwn = npm(["run", "check"], project);
  check("npm run check passes the project with a kernel.json of its own", checkedOwn.status === 0, checkedOwn.out);

  // ---- 3. npm run deploy, without deploying ----
  const laid = npm(["run", "deploy", "--", "--no-deploy"], project);
  const deploy = join(project, ".extensible/deploy");
  const config = existsSync(join(deploy, "wrangler.jsonc")) ? JSON.parse(readFileSync(join(deploy, "wrangler.jsonc"), "utf8").replace(/^\/\/.*$/gm, "")) : {};
  const kernelFile = existsSync(join(deploy, "site/assets")) ? readdirSync(join(deploy, "site/assets")).find((name) => /^browser-.*\.js$/.test(name)) : undefined;
  const written = (text) => {
    const found = /site:kernel\.json=([A-Za-z0-9+/]+)/.exec(text);
    return found ? JSON.parse(Buffer.from(found[1], "base64").toString()) : undefined;
  };
  check(
    "npm run deploy -- --no-deploy lays the Worker out: the app at /, the platform around it, and the project's kernel.json in its kernels",
    laid.status === 0 && config.name === "packing-list" && config.vars?.EXTENSIBLE_APP === "packing-list" && /<base href="\/">/.test(readFileSync(join(deploy, "site/index.html"), "utf8")) && existsSync(join(deploy, "site/main.js")) && existsSync(join(deploy, "site/platform/host.js")) && !existsSync(join(deploy, "site/kernel.json")) && !existsSync(join(deploy, "site/package.json")) &&
      !!kernelFile && written(readFileSync(join(deploy, "site/assets", kernelFile), "utf8"))?.modules.join() === "debug,router" && written(readFileSync(join(deploy, "platform/.build/cloudflare/kernel-source.js"), "utf8"))?.hooks.max === 3 && existsSync(join(deploy, config.main ?? "missing")),
    `${laid.out}\n${JSON.stringify(config).slice(0, 300)}`,
  );
  const bundled = npm(["wrangler", "deploy", "--dry-run", "--outdir", join(deploy, "bundled"), "-c", ".extensible/deploy/wrangler.jsonc"], project, { command: "npx", env: { CI: "1", WRANGLER_SEND_METRICS: "false" } });
  const bundle = existsSync(join(deploy, "bundled")) ? readdirSync(join(deploy, "bundled")).filter((name) => name.endsWith(".js")).map((name) => readFileSync(join(deploy, "bundled", name), "utf8")).join("\n") : "";
  check("wrangler bundles the project's Worker, with the project's kernel.json in the kernel its spaces run", bundled.status === 0 && written(bundle)?.modules.join() === "debug,router", bundled.out);

  // ---- 4. extensible-app dev ----
  // Started with Node, as `npm run dev` starts it, so it can be stopped on every system.
  const port = await freePort();
  let log = "";
  devServer = spawn(process.execPath, [join(project, "node_modules/extensible-web-apps/scripts/extensible-app.mjs"), "dev", "--port", String(port)], { cwd: project, stdio: "pipe" });
  devServer.stdout.on("data", (d) => (log += d));
  devServer.stderr.on("data", (d) => (log += d));
  const up = await new Promise((done) => {
    const timer = setTimeout(() => done(false), 60_000);
    devServer.stdout.on("data", () => /Your app is at/.test(log) && (clearTimeout(timer), done(true)));
    devServer.on("exit", () => (clearTimeout(timer), done(false)));
  });
  check("extensible-app dev starts", up, log);
  if (up) {
    const at = `http://127.0.0.1:${port}`;
    const get = async (path) => {
      const response = await fetch(at + path).catch((error) => ({ status: 0, text: async () => String(error) }));
      return { status: response.status, text: await response.text() };
    };
    const front = await get("/");
    check("it serves the app at /, as an app at the root", front.status === 200 && front.text.includes("<title>Packing list</title>") && front.text.includes('<base href="/">'), `${front.status} ${front.text.slice(0, 200)}`);
    const [plugin, host, worker, std] = await Promise.all([get("/main.js"), get("/platform/host.js"), get("/sw.js"), get("/std/debug-console.js")]);
    check("it serves the project's files and the platform's beside them", [plugin, host, worker, std].every((r) => r.status === 200) && plugin.text.includes('id: "packing-list"'), [plugin, host, worker, std].map((r) => r.status).join(", "));
    const kernel = await get(`/assets/${kernelFile}`);
    check("the browser's kernel it serves has the project's kernel.json in it", kernel.status === 200 && written(kernel.text)?.modules.join() === "debug,router" && written(kernel.text)?.hooks.max === 3, String(kernel.status));
    const not = await Promise.all(["/package.json", "/kernel.json", "/node_modules/extensible-web-apps/package.json", "/.extensible/site/index.html", "/demos/habits/app.html"].map(get));
    check("it serves neither the project's package.json, its kernel.json, node_modules, nor this site's demos", not.every((r) => r.status === 404), not.map((r) => r.status).join(", "));
    // A file added while it runs is served without a restart.
    writeFileSync(join(project, "note.txt"), "added");
    let added = { status: 0 };
    for (let tries = 0; tries < 50 && added.status !== 200; tries++) {
      await new Promise((wait) => setTimeout(wait, 200));
      added = await get("/note.txt");
    }
    check("a file added to the project while it runs is served", added.status === 200 && added.text === "added", String(added.status));
  }
} catch (error) {
  check("the project checks ran to the end", false, error.stack ?? error);
} finally {
  packageFiles.forEach((file, i) => writeFileSync(file, before[i]));
  if (devServer && devServer.exitCode === null) {
    devServer.kill();
    await new Promise((done) => (devServer.exitCode === null ? devServer.once("exit", done) : done()));
  }
  // On Windows a folder can stay locked for a moment after what used it stops: leaving it behind fails nothing.
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {}
}

console.log(failed ? `\n${failed} project check${failed > 1 ? "s" : ""} failed` : "\nAll project checks passed");
process.exit(failed ? 1 : 0);
