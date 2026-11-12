// The core has no apps or plugins of its own: the kernel, host, sandbox,
// service worker and servers never import a plugin, a demo or the homepage,
// and an app runs only the plugins its app.html links. The demo plugins in
// site/workbench/plugins/ run on the workbench, which links them, and nowhere else.
// Kernel modules in std/<name>/module.ts reach the kernel only through the
// site's kernel.json (vite.kernel-modules.ts), never by an import in the core.
import { watchErrors } from "../page-errors.mjs";
import { readdirSync, readFileSync, statSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url);
/** The platform's own code. */
const CORE = ["src", "sw", "sw.js"];
/** Folders of apps and plugins, which the core must never import. */
const APPS = ["demos", "site", "std", "starter", "docs"];

const files = (path) => {
  const url = new URL(path, ROOT);
  if (!statSync(url).isDirectory()) return [path];
  return readdirSync(url, { withFileTypes: true }).flatMap((e) => (e.name.startsWith(".") ? [] : files(`${path}/${e.name}`)));
};

export default async function ({ check, context, URL: site, errors }) {
  // import x from "../../site/workbench/plugins/x.js?raw", import "../demos/x.js", import("../site/home/x.js"),
  // import.meta.glob("../../std/*"), new URL("../docs/…", import.meta.url): over the whole file, so an
  // import split across lines counts too.
  const reaches = new RegExp(String.raw`(?:\b(?:from|import)\s*\(?|import\.meta\.glob\s*(?:<[^>]*>)?\s*\(\s*\[?|new URL\s*\()\s*["'\x60](?:\.\.?/)+(?:${APPS.join("|")})/`, "g");
  const found = CORE.flatMap(files)
    .filter((path) => /\.(ts|js|mjs)$/.test(path))
    .flatMap((path) => {
      const text = readFileSync(new URL(path, ROOT), "utf8");
      return [...text.matchAll(reaches)].map((m) => `${path}:${text.slice(0, m.index).split("\n").length}`);
    });
  check("the core imports no plugin, demo or page of the site", !found.length, found.join(", "));

  // An app runs only what it links: habits links habits.js, so that is the only worker its tab starts. Customize
  // (std/customize.js, which the host adds to every app) starts when it is first opened (tests/checks/stand-in.mjs).
  const own = await context.browser().newContext();
  const page = await own.newPage();
  watchErrors(page, errors, "no-baked-apps");
  await page.goto(`${site}demos/habits/app.html`);
  await page.waitForFunction(() => window.__host?.workers?.has("habits"), null, { timeout: 10000 }).catch(() => {});
  // Long enough for any plugin the kernel started on its own to have been spawned too.
  await page.waitForTimeout(1500);
  const running = await page.evaluate(() => [...window.__host.workers.keys()].map((key) => key.split("@")[0]).sort());
  check("an app runs only the plugins it links", running.join() === "habits", running.join(", "));

  // With the workbench open in the same browser, one kernel serves both tabs. The workbench's tab-scoped
  // demo plugin (bars) runs in the workbench's tab only, not in the habits tab beside it.
  const bench = await own.newPage();
  await bench.goto(`${site}workbench/`);
  await bench.waitForFunction(() => [...(window.__host?.workers?.keys() ?? [])].some((k) => k.startsWith("bars@")), null, { timeout: 10000 }).catch(() => {});
  const second = await own.newPage();
  watchErrors(second, errors, "no-baked-apps");
  await second.goto(`${site}demos/habits/app.html`);
  await second.waitForSelector('[data-key^="habits:"]', { state: "attached", timeout: 10000 }).catch(() => {});
  await second.waitForTimeout(1500);
  const beside = await second.evaluate(() => [...window.__host.workers.keys()].filter((key) => key.includes("@") && !key.startsWith("customize@")));
  check("a tab-scoped plugin runs only in the tabs whose app links it", !beside.length, beside.join(", "));
  await own.close();
}
