// An app's folder is its page (scripts/folder-pages.mjs): the build writes each app.html at its folder's
// index.html too, so a first visit to the address people share (/demos/habits/) is answered with the app,
// not with 404.html and a second load once the service worker has started. A screen deeper in the app is
// no file, and still opens by way of 404.html.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { watchErrors } from "../page-errors.mjs";
import { folderPages } from "../../scripts/folder-pages.mjs";
import { hintedFiles } from "../../sw/preload-hints.js";

const DIST = new globalThis.URL("../../dist/", import.meta.url);
/** Every app.html in the build, as a path from its root. */
const apps = (under = "") =>
  readdirSync(new globalThis.URL(under || ".", DIST), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? apps(`${under}${entry.name}/`) : entry.name === "app.html" ? [`${under}app.html`] : []));

export default async function ({ check, context, URL, errors }) {
  check(
    "the rule for folder pages: an app's folder gets its page, and a folder with an index.html of its own keeps it",
    JSON.stringify(folderPages(["demos/habits/app.html", "demos/index.html", "kept/app.html", "kept/index.html", "app.html", "demos/habits/form.html"])) === JSON.stringify({ "demos/habits/index.html": "demos/habits/app.html", "index.html": "app.html" }),
  );

  // The build: every app's folder has a page, the app's own, preload hints and all.
  const built = apps();
  const missing = built.filter((app) => !existsSync(new globalThis.URL(app.replace(/app\.html$/, "index.html"), DIST)));
  check("the build writes a page at every app's folder", built.length > 10 && !missing.length, `${built.length} apps; none at ${missing.join(", ")}`);
  const habits = readFileSync(new globalThis.URL("demos/habits/index.html", DIST), "utf8");
  check("an app's folder page is its app.html, with the same preload hints", habits === readFileSync(new globalThis.URL("demos/habits/app.html", DIST), "utf8") && hintedFiles(habits).length > 3, `${hintedFiles(habits).length} hints`);
  check("the folder pages are made, not committed", !existsSync(new globalThis.URL("../../demos/habits/index.html", import.meta.url)));

  // A first visit to the folder, in a browser that has never been here.
  const own = await context.browser().newContext();
  try {
    const page = await own.newPage();
    watchErrors(page, errors, "folder-page");
    const documents = [];
    page.on("response", (response) => response.request().resourceType() === "document" && documents.push(`${response.status()} ${new globalThis.URL(response.url()).pathname}`));
    await page.goto(`${URL}demos/habits/`, { waitUntil: "commit" });
    const drawn = await page.waitForSelector('[data-key="habits:habits"] ui-form', { timeout: 15000 }).then(() => true, () => false);
    check("a first visit to an app's folder is answered with the app, with no not-found page on the way", drawn && documents.join() === "200 /demos/habits/", documents.join());
    check("the app opened at its folder keeps the folder's address, and its links resolve there", (await page.evaluate(() => location.pathname + " " + document.baseURI.replace(location.origin, ""))) === "/demos/habits/ /demos/habits/");

    // The next visit: the service worker answers the folder with the app's page, as before.
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
    // It answers with the folder's app.html, which the first visit never asked for: kept all the same, so the visit back doesn't wait on the network for it.
    const kept = await page.waitForFunction(async () => !!(await caches.match("/demos/habits/app.html")), null, { timeout: 10000 }).then(() => true, () => false);
    check("after a first visit to the folder the service worker has kept the app's page it will answer with", kept);
    await page.goto(`${URL}demos/habits/`);
    const again = await page.waitForSelector('[data-key="habits:habits"] ui-form', { timeout: 15000 }).then(() => true, () => false);
    check("the next visit to the folder opens the app through the service worker", again && (await page.evaluate(() => !!navigator.serviceWorker.controller)));
  } finally {
    await own.close();
  }

  // A screen inside an app has no file: a first visit still goes by way of 404.html, which starts the service worker.
  const fresh = await context.browser().newContext();
  try {
    const page = await fresh.newPage();
    watchErrors(page, errors, "folder-page screen");
    const first = await page.goto(`${URL}demos/reading-list/book/42`, { waitUntil: "commit" }).catch(() => undefined);
    const opened = await page.waitForSelector('[data-key]:not([data-key^="customize:"])', { timeout: 20000 }).then(() => true, () => false);
    check("a first visit to a screen inside an app still opens it, by way of the not-found page", first?.status() === 404 && opened && (await page.evaluate(() => location.pathname + " " + document.baseURI.replace(location.origin, ""))) === "/demos/reading-list/book/42 /demos/reading-list/", `${first?.status()} ${opened}`);
  } finally {
    await fresh.close();
  }
}
