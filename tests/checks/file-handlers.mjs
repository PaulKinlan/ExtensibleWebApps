// Opening files with an installed app (std/launch/module.ts, the host's launch
// bridge, demos/reading-list/book-files.js): the reading list's manifest names
// the screen ebooks open at, and a file opened there becomes a book to read,
// after a review, once. The browser's launch queue only fills for an installed
// app opened from the person's files, so a stand-in hands the page the files.
import { watchErrors } from "../page-errors.mjs";

export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  await own.addInitScript(() => {
    if (!location.pathname.endsWith("/reading-list/open")) return;
    const file = (name, type, text) => ({ kind: "file", getFile: async () => new File([text], name, { type }) });
    // Chromium has a launchQueue of its own, which a plain assignment doesn't replace.
    Object.defineProperty(window, "launchQueue", {
      configurable: true,
      value: {
        setConsumer(consumer) {
          setTimeout(() => consumer({ files: [file("a-memory_called_empire.epub", "application/epub+zip", "PK…"), file("notes.md", "text/markdown", "# Notes")] }), 50);
        },
      },
    });
  });
  const page = await own.newPage();
  watchErrors(page, errors, "file-handlers");

  // The manifest says where files open.
  await page.goto(`${URL}demos/reading-list/manifest.webmanifest`);
  const manifest = JSON.parse(await page.textContent("body"));
  check("the reading list's manifest opens .pdf and .epub files at its open screen", manifest.file_handlers?.[0]?.action === "open" && manifest.file_handlers[0].accept["application/epub+zip"]?.includes(".epub"), JSON.stringify(manifest.file_handlers));

  // Through the service worker, so /open is a screen of the app.
  await page.goto(`${URL}demos/reading-list/app.html`);
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("load");
  await page.goto(`${URL}demos/reading-list/open`);
  const review = '[data-key^="review:"]';
  const asked = await page.waitForSelector(`${review} >> text=a memory called empire`, { timeout: 10000 }).then(() => true, () => false);
  const shown = asked ? await page.textContent(review) : "";
  check("an ebook opened with the reading list is offered as a book to read, for review", shown.includes("a-memory_called_empire.epub"), shown.slice(0, 200));
  await page.click(`${review} >> text=Accept`).catch(() => {});
  const added = await page.waitForSelector('[data-key="library:books"] ui-table >> text=a memory called empire', { timeout: 8000 }).then(() => true, () => false);
  check("accepted, the book is in the library, and the tab is back at the app's own address", added && new globalThis.URL(page.url()).pathname === "/demos/reading-list/", page.url());

  // Taken once: the files are gone after, so a reload adds nothing. The Markdown file isn't a book, so it was never offered.
  await page.reload();
  await page.waitForSelector('[data-key="library:books"] ui-table', { timeout: 8000 });
  await page.waitForTimeout(800);
  const rows = await page.$$eval('[data-key="library:books"] ui-table >> text=a memory called empire', (els) => els.length).catch(() => -1);
  check("the files are taken once: a reload doesn't add the book again, and a file that isn't an ebook isn't offered", rows === 1 && !(await page.$(review)), `${rows} rows`);
  await own.close();
}
