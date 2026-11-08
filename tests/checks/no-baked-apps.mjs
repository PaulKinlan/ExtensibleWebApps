// The core has no apps or plugins of its own: the kernel, host, sandbox,
// service worker and servers never import a plugin, a demo or the homepage,
// and an app runs only the plugins its app.html links. The demo plugins in
// plugins/ run on the workbench, which links them, and nowhere else.
import { readdirSync, readFileSync, statSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url);
/** The platform's own code. */
const CORE = ["src", "sw", "sw.js"];
/** Folders of apps and plugins, which the core must never import. */
const APPS = ["plugins", "demos", "home", "std", "starter", "workbench", "docs"];

const files = (path) => {
  const url = new URL(path, ROOT);
  if (!statSync(url).isDirectory()) return [path];
  return readdirSync(url, { withFileTypes: true }).flatMap((e) => (e.name.startsWith(".") ? [] : files(`${path}/${e.name}`)));
};

export default async function ({ check, context, URL: site, errors }) {
  // import x from "../../plugins/x.js?raw", import.meta.glob("../../demos/*"), new URL("../home/…", import.meta.url)
  const reaches = new RegExp(String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|import\.meta\.glob\s*(?:<[^>]*>)?\s*\(\s*\[?\s*|new URL\s*\(\s*)["'\x60](?:\.\.?/)+(?:${APPS.join("|")})/`);
  const found = CORE.flatMap(files)
    .filter((path) => /\.(ts|js|mjs)$/.test(path))
    .flatMap((path) => readFileSync(new URL(path, ROOT), "utf8").split("\n").flatMap((line, i) => (reaches.test(line) ? [`${path}:${i + 1}`] : [])));
  check("the core imports no plugin, demo or page of the site", !found.length, found.join(", "));

  // An app runs only what it links: habits links habits.js, so that is the only worker its tab starts.
  const own = await context.browser().newContext();
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${site}demos/habits/app.html`);
  await page.waitForFunction(() => window.__host?.workers?.has("habits"), null, { timeout: 10000 }).catch(() => {});
  // Long enough for any plugin the kernel started on its own to have been spawned too.
  await page.waitForTimeout(1500);
  const running = await page.evaluate(() => [...window.__host.workers.keys()].map((key) => key.split("@")[0]).sort());
  check("an app runs only the plugins it links", running.length === 1 && running[0] === "habits", running.join(", "));
  await own.close();
}
