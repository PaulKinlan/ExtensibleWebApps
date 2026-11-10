// The launch service started late (std/launch/module.ts), with an app of its own.
//
// An app says which files open with it in its page (<meta name="file-handlers">), the browser starts it at its
// open screen and hands the page the files, and a plugin has them with launch.take(). The launch service is a
// kernel module, fetched the first time something uses it, which can be long after the tab opened: here the
// app's plugin (tests/fixtures/launch-app/) asks for the files only when its button is pressed. The files must
// still be there, once, and the tab must go back to the app's own address.
//
// Checked both ways a tab gets to the open screen:
// - the browser handed the page files (the page tells the kernel, whenever that is);
// - nothing was handed over (someone opened the address by hand): the module finds the tab at the open screen
//   when it starts, and answers with no files rather than leaving the plugin waiting.
//
// The app is put in the browser as an app made there (/apps/logbook/), so its manifest, with file_handlers, is
// the one the service worker makes from the page. file-handlers.mjs checks the same service started early.
import { readFileSync } from "node:fs";
import { watchErrors } from "../page-errors.mjs";

const fixture = (name) => readFileSync(new URL(`../fixtures/launch-app/${name}`, import.meta.url), "utf8");
const FILES = Object.fromEntries(["app.html", "opened.js", "opened.html"].map((name) => [name, fixture(name)]));

export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  // A stand-in for the browser's launch queue, which only fills for an installed app opened from a file. It
  // hands over files when the address says so (?files), a moment after the page starts, as the browser does.
  await own.addInitScript(() => {
    if (!location.pathname.endsWith("/logbook/open")) return;
    const handed = new URLSearchParams(location.search).has("files");
    const file = (name, type, text) => ({ kind: "file", getFile: async () => new File([text], name, { type }) });
    // Chromium has a launchQueue of its own, which a plain assignment doesn't replace.
    Object.defineProperty(window, "launchQueue", {
      configurable: true,
      value: {
        setConsumer(consumer) {
          if (handed) setTimeout(() => consumer({ files: [file("march.csv", "text/csv", "day,km\n1,5"), file("notes.md", "text/markdown", "# Notes")] }), 50);
        },
      },
    });
  });
  const page = await own.newPage();
  watchErrors(page, errors, "launch-late");
  const APP = `${URL}apps/logbook/`;
  const running = async () => (await page.evaluate(() => window.__host.command("modules"))).filter((m) => m.running).map((m) => m.name);
  const button = '[data-key="opened:opened"] button[data-action="take"]';
  /** Opens the app's open screen, waits for its plugin's button, and says whether launch is running yet. */
  const openAt = async (search) => {
    await page.goto(`${APP}open${search}`);
    const drawn = await page.waitForSelector(button, { timeout: 15000 }).then(() => true, () => false);
    // Long enough for the stand-in to hand its files over and the page to tell the kernel.
    await page.waitForTimeout(800);
    return { drawn, early: drawn ? (await running()).includes("launch") : false };
  };
  const listed = () => page.$$eval('[data-key="opened:opened"] li', (items) => items.map((li) => li.textContent.replace(/\s+/g, " ").trim()));
  const asked = (n) => page.waitForSelector(`[data-key="opened:opened"] .opened[data-asked="${n}"]`, { timeout: 15000 }).then(() => true, () => false);
  const atApp = () => page.waitForFunction(() => location.pathname === "/apps/logbook/", null, { timeout: 5000 }).then(() => true, () => false);

  try {
    // The app's files, where apps made in the browser are kept. Any page of the site can put them there.
    await page.goto(`${URL}demos/habits/app.html`);
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("load");
    await page.evaluate(async (files) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of ["made", "apps", "logbook"]) dir = await dir.getDirectoryHandle(part, { create: true });
      for (const [name, text] of Object.entries(files)) {
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(text);
        await writable.close();
      }
    }, FILES);

    const manifest = await page.evaluate(async (app) => (await fetch(`${app}manifest.webmanifest`)).json().catch(() => null), APP);
    check(
      "the fixture app's manifest, made from its page, opens .csv and .md files at its open screen",
      manifest?.file_handlers?.[0]?.action === "open" && manifest.file_handlers[0].accept?.["text/csv"]?.includes(".csv") && manifest.file_handlers[0].accept?.["text/markdown"]?.includes(".md"),
      JSON.stringify(manifest?.file_handlers ?? manifest),
    );

    // ---- Nothing handed over: the module starts when the button is pressed, and finds the tab at the open screen ----
    const bare = await openAt("");
    await page.click(button).catch(() => {});
    const answered = await asked(1);
    check(
      "launch, started by a plugin long after its tab opened at the open screen, answers with no files, and the tab goes back to the app",
      bare.drawn && !bare.early && answered && (await listed()).length === 0 && !!(await page.$('[data-key="opened:opened"] .none')) && (await atApp()) && (await running()).includes("launch"),
      `drawn ${bare.drawn}, launch running before ${bare.early}, answered ${answered}, at ${new globalThis.URL(page.url()).pathname}`,
    );

    // ---- Files handed over before any plugin asked: they wait for the plugin ----
    const handed = await openAt("?files");
    await page.click(button).catch(() => {});
    const took = await asked(1);
    const files = await listed();
    check(
      "files the browser handed the page before any plugin asked are still there when one does, with a text file's text",
      handed.drawn && took && files.length === 2 && files[0] === "march.csv text/csv day,km 1,5" && files[1] === "notes.md text/markdown # Notes",
      `drawn ${handed.drawn}, took ${took}, ${JSON.stringify(files)}`,
    );
    const back = await atApp();
    await page.click(button).catch(() => {});
    const again = await asked(2);
    check("they are taken once, and the tab is back at the app's own address", back && again && (await listed()).length === 0, `back ${back}, again ${again}, ${JSON.stringify(await listed())}`);
  } finally {
    await own.close();
  }
}
