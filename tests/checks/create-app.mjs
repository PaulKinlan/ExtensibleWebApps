// `npx github:PaulKinlan/ExtensibleWebApps <folder>` (scripts/create-app.mjs):
// it makes a project that is one app, its files at the top and the platform as
// a dependency, not a copy; it refuses bad names and folders in use, and the
// command npm finds is that script. The project's `extensible-app dev`
// (scripts/extensible-app.mjs) serves the app at / with the platform around it,
// a screen of it (/book/42) opens it too, and `extensible-app check` checks it.
// And the homepage's chapter 10 shows the command.
//
// It makes the project with --no-install, so it needs no network, and runs it
// against this checkout, which `npm test` has built.
import { watchErrors } from "../page-errors.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeProject } from "../../scripts/create-app.mjs";
import { check as checkProject, dev, layoutProject } from "../../scripts/extensible-app.mjs";

export default async function ({ check, context, URL, errors }) {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  check("npx finds scripts/create-app.mjs as the repo's one command", pkg.bin?.["create-extensible-app"] === "scripts/create-app.mjs" && readFileSync("scripts/create-app.mjs", "utf8").startsWith("#!/usr/bin/env node"));
  check("npx github:… runs create-app: a bin has the package's own name", pkg.bin?.[pkg.name] === "scripts/create-app.mjs");
  check("a project runs the platform's extensible-app command", pkg.bin?.["extensible-app"] === "scripts/extensible-app.mjs" && readFileSync("scripts/extensible-app.mjs", "utf8").startsWith("#!/usr/bin/env node"));
  check("installing the platform from GitHub builds it, and the package keeps what it built", /npm run build\b/.test(pkg.scripts?.prepare ?? "") && /build:server/.test(pkg.scripts?.prepare ?? "") && !/^\/?(dist|\.build)\/?$/m.test(readFileSync(".npmignore", "utf8")));

  const wrapper = JSON.parse(readFileSync("scripts/create-extensible-app/package.json", "utf8"));
  const runs = readFileSync("scripts/create-extensible-app/index.mjs", "utf8");
  check("npm create extensible-app is a package that runs the repo's command from GitHub", wrapper.name === "create-extensible-app" && wrapper.bin?.["create-extensible-app"] === "index.mjs" && wrapper.files?.includes("index.mjs") && runs.startsWith("#!/usr/bin/env node") && runs.includes('"github:PaulKinlan/ExtensibleWebApps"'));

  const scratch = mkdtempSync(join(tmpdir(), "create-app-"));
  let server;
  try {
    const run = (...args) => spawnSync(process.execPath, ["scripts/create-app.mjs", ...args], { encoding: "utf8" });
    const folder = join(scratch, "packing-list");
    const made = run(folder, "--name", "Packing list", "--no-install", "--platform", `file:${resolve(".")}`);
    const has = (p) => existsSync(join(folder, p));
    const project = has("package.json") ? JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) : {};
    check(
      "create-app makes a project of the app's own files at the top, with the platform as a dependency, not a copy",
      made.status === 0 && has("app.html") && has("main.js") && has("main.html") && has("README.md") && has(".gitignore") && !has("src") && !has("std") && !has("demos") && !has("node_modules"),
      `${made.status} ${made.stderr}`,
    );
    check(
      "the project is named after its folder, depends on the platform, and its scripts run extensible-app",
      project.name === "packing-list" && project.dependencies?.[pkg.name] === `file:${resolve(".")}` && project.scripts?.dev === "extensible-app dev" && project.scripts?.check === "extensible-app check" && project.scripts?.deploy === "extensible-app deploy",
      JSON.stringify(project),
    );
    const page = has("app.html") ? readFileSync(join(folder, "app.html"), "utf8") : "";
    check("the app is the starter, named, without the demo gallery's card", page.includes("<title>Packing list</title>") && !page.includes('name="gallery') && readFileSync(join(folder, "main.js"), "utf8").includes('id: "packing-list"'));
    check("by default the platform comes from GitHub", makeProject(join(scratch, "from-github")) && JSON.parse(readFileSync(join(scratch, "from-github", "package.json"), "utf8")).dependencies?.[pkg.name] === "github:PaulKinlan/ExtensibleWebApps");
    check("create-app says what to run next", /npm install\n\s+npm run dev/.test(made.stdout), made.stdout);
    const again = run(folder, "--no-install");
    check("create-app won't write into a folder that has files in it", again.status === 1 && /isn't empty/.test(again.stderr), again.stderr);
    let refused = "";
    try { makeProject(join(scratch, "Packing_List")); } catch (error) { refused = error.message; }
    check("create-app refuses a folder name that can't be an app's id", /lowercase letters/.test(refused) && !existsSync(join(scratch, "Packing_List")), refused);
    let reserved = "";
    try { makeProject(join(scratch, "kernel")); } catch (error) { reserved = error.message; }
    check("create-app refuses a name the kernel keeps for itself", /keeps for itself/.test(reserved) && !existsSync(join(scratch, "kernel")), reserved);
    const noTitle = run(join(scratch, "titled"), "--name", "--no-install");
    check("create-app refuses --name with no title, and writes nothing", noTitle.status === 2 && /--name needs a title/.test(noTitle.stderr) && !existsSync(join(scratch, "titled")), noTitle.stderr);

    // The project's commands, against this checkout's built platform. A secret in a folder of the app is never served.
    mkdirSync(join(folder, "plugins"));
    writeFileSync(join(folder, "plugins", ".env"), "SECRET=1");
    writeFileSync(join(folder, "plugins", "note.txt"), "hi");
    const page0 = readFileSync(join(folder, "app.html"), "utf8");
    writeFileSync(join(folder, "app.html"), page0.replace('href="main.js"', 'href="/main.js"'));
    const rooted = await checkProject(folder);
    writeFileSync(join(folder, "app.html"), page0);
    check("extensible-app check finds a file linked from the root (/main.js) in the project", rooted.plugins.includes("packing-list") && !rooted.problems.some((p) => p.level === "error"), JSON.stringify(rooted.problems));
    const checked = await checkProject(folder);
    check("extensible-app check checks the project's app, naming its files from the project", checked.plugins.includes("packing-list") && !checked.problems.some((p) => p.level === "error"), JSON.stringify(checked.problems));
    writeFileSync(join(scratch, "from-github", "std"), "");
    let clash = "";
    try { layoutProject(join(scratch, "from-github")); } catch (error) { clash = error.message; }
    check("a project's file can't take the address of one of the platform's", /same address as the platform's \/std/.test(clash), clash);
    const laid = layoutProject(folder);
    check("a project's Worker is marked with the project's name, whatever the Worker is called, so another project can't replace it unasked", layoutProject(folder, { name: "shared" }).app === "packing-list");
    layoutProject(folder);
    const deployed = JSON.parse(readFileSync(laid.config, "utf8").replace(/^\/\/.*$/gm, ""));
    check(
      "extensible-app deploy lays out the app at / with the platform around it, and none of this site's own pages",
      readFileSync(join(laid.site, "index.html"), "utf8") === readFileSync(join(folder, "app.html"), "utf8") && existsSync(join(laid.site, "main.js")) && existsSync(join(laid.site, "platform", "host.js")) && existsSync(join(laid.site, "std")) && !existsSync(join(laid.site, "demos")) && !existsSync(join(laid.site, "docs")) && !existsSync(join(laid.site, "package.json")) && deployed.name === "packing-list" && deployed.assets?.directory === "./site" && deployed.vars?.EXTENSIBLE_APP === "packing-list" && !deployed.vars?.EMAIL_FROM && existsSync(join(laid.site, "plugins", "note.txt")) && !existsSync(join(laid.site, "plugins", ".env")),
      JSON.stringify(deployed),
    );

    server = await dev(folder, { port: 0, quiet: true });
    const own = await context.browser().newContext();
    const tab = await own.newPage();
    watchErrors(tab, errors, "create-app");
    await tab.goto(server.url);
    const drawn = await tab.waitForSelector('slot[name="main"] ui-form', { timeout: 15000 }).then(() => true, () => false);
    check("extensible-app dev serves the project's app at /", drawn && (await tab.title()) === "Packing list");
    await tab.goto(new globalThis.URL("book/42", server.url).href);
    const screen = await tab.waitForSelector('slot[name="main"] ui-form', { timeout: 15000 }).then(() => true, () => false);
    check("a screen of an app at / (/book/42) opens the app, through the service worker", screen && (await tab.evaluate(() => document.baseURI)).endsWith("/"));
    const notServed = await tab.evaluate(async () => [(await fetch("/package.json")).status, (await fetch("/demos/habits/app.html")).status, (await fetch("/plugins/.env")).status]);
    check("a project serves neither its package.json, nor a dot file in its folders, nor this site's demos", notServed.every((s) => s === 404), notServed.join(", "));
    const served = await tab.evaluate(async () => (await fetch("/plugins/note.txt")).status);
    check("the project's other files are served, at any depth", served === 200, String(served));
    await tab.goto(new globalThis.URL("account/", server.url).href);
    await tab.waitForLoadState("load");
    check("the platform's own pages (/account/) open as themselves, not as the app at /", (await tab.title()) !== "Packing list", await tab.title());
    await own.close();
  } finally {
    await server?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }

  const own = await context.browser().newContext();
  const page = await own.newPage();
  watchErrors(page, errors, "create-app");
  await page.goto(URL);
  const chapter = 'slot[name="your-app"] .chapter';
  const shown = await page.waitForSelector(`${chapter} >> text=npm create extensible-app packing-list`, { state: "attached", timeout: 8000 }).then(() => true, () => false);
  const appHtml = shown && (await page.textContent(`${chapter} pre`)).includes('<link rel="plugin" href="main.js">');
  const atRoot = shown && (await page.textContent(chapter)).includes("http://localhost:5173/") && !(await page.textContent(chapter)).includes("demos/packing-list");
  check("chapter 10 shows an app.html as text and the command that makes an app of your own", shown && appHtml);
  check("chapter 10 says a project's app is served at /, not in demos/", atRoot);
  await own.close();
}
