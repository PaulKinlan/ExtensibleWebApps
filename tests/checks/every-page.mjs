// Opens every page the site has, at a phone's width and a desktop's: the
// front page, the demo gallery, the docs, the plugin registry, the app maker,
// the workbench, the account page, and every app in demos/. A new demo is
// picked up from its folder, so nothing here names one.
//
// Each page fails the run if it logs an error to the console, throws one, asks
// the site for a file that isn't there, or never draws: an app page with no
// plugin's view on it, or a page with next to nothing to read.
//
// How the pages are laid out at those widths (controls too big, sideways
// scroll) is tests/checks/layout-sanity.mjs, which visits the same pages.
import { existsSync, readdirSync } from "node:fs";
import { describeError } from "../page-errors.mjs";

const SIZES = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
};
/** The site's own pages; every demo's app.html is added to them. */
const SITE_PAGES = ["", "demos/", "docs/", "packages/", "new/", "workbench/", "account/"];

/** What the page shows once it has settled: how many plugin views are drawn, and how much there is to read. */
const drawn = () => {
  const seen = (/** @type {Element} */ el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  // Text inside shadow roots counts: most of the site's pages are drawn by elements.
  const text = (/** @type {Node} */ node) => {
    let all = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) all += child.textContent;
      else if (child.nodeType === 1 && !["SCRIPT", "STYLE", "TEMPLATE"].includes(/** @type {Element} */ (child).tagName)) all += text(child) + (/** @type {Element} */ (child).shadowRoot ? text(/** @type {Element} */ (child).shadowRoot) : "");
    }
    return all;
  };
  return {
    plugins: document.querySelectorAll('link[rel="plugin"], link[rel="agent"]').length,
    // Customize is on every app's page, whatever the app links: it doesn't show that the app drew.
    views: [...document.querySelectorAll('[data-key]:not([data-key^="customize"])')].filter(seen).length,
    words: text(document.body).trim().split(/\s+/).filter(Boolean).length,
  };
};

export default async function ({ check, context, URL: site }) {
  const demos = new globalThis.URL("../../demos/", import.meta.url);
  const apps = readdirSync(demos, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(new globalThis.URL(`${d.name}/app.html`, demos)))
    .map((d) => `demos/${d.name}/app.html`)
    .sort();
  const pages = [...SITE_PAGES, ...apps];
  /** @type {string[]} */
  const problems = [];
  let opened = 0;

  for (const [size, viewport] of Object.entries(SIZES)) {
    // A browser context for each size, so the pages share one kernel as a person's tabs do, and none of the other checks' data.
    const own = await context.browser().newContext({ viewport });
    try {
      for (const path of pages) {
        const at = `/${path} (${size})`;
        const page = await own.newPage();
        /** @type {string[]} */
        const found = [];
        // The runner watches every page for uncaught errors too; here each is put beside its page and size.
        page.on("pageerror", (e) => found.push(`threw ${describeError(undefined, page, e)}`));
        page.on("console", (message) => {
          if (message.type() === "error") found.push(`console error: ${message.text().slice(0, 300)}`);
        });
        page.on("response", (response) => {
          if (response.status() >= 400 && response.url().startsWith(site)) found.push(`${response.status()} for ${new globalThis.URL(response.url()).pathname}`);
        });
        try {
          await page.goto(`${site}${path}`, { waitUntil: "load", timeout: 30000 });
          // An app page has drawn once a view of a plugin it links is on it; any page, once it has something to read.
          const isApp = await page.evaluate(() => !!document.querySelector('link[rel="plugin"], link[rel="agent"]'));
          if (isApp) await page.waitForFunction(() => [...document.querySelectorAll('[data-key]:not([data-key^="customize"])')].some((el) => el.getBoundingClientRect().height > 0), null, { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(700);
          const shown = await page.evaluate(drawn);
          if (shown.plugins && !shown.views) found.push(`never drew: it links ${shown.plugins} plugins and no view is on the page`);
          if (shown.words < 5) found.push(`never drew: ${shown.words} words on the page`);
          opened++;
        } catch (error) {
          found.push(`didn't open: ${String(error?.message ?? error).split("\n")[0]}`);
        }
        await page.close({ runBeforeUnload: true }).catch(() => {});
        for (const f of [...new Set(found)]) problems.push(`${at}: ${f}`);
      }
    } finally {
      await own.close();
    }
  }

  check(
    "every page of the site and every demo opens at a phone's width and a desktop's, draws, and logs no error",
    problems.length === 0 && opened === pages.length * Object.keys(SIZES).length,
    problems.length ? `\n  ${problems.slice(0, 40).join("\n  ")}${problems.length > 40 ? `\n  and ${problems.length - 40} more` : ""}` : `${pages.length} pages at ${Object.keys(SIZES).length} sizes`,
  );
}
