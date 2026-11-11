// A part of the platform first used offline works (sw/parts.js, vite.parts.ts).
//
// An app downloads only what it uses: a kernel module, the review card or the API reference is fetched the first
// time something asks for it. So that this also works with no network, the build lists every such file
// (/platform/parts.json) and the service worker keeps them all, a few seconds after a visit begins. Here an app
// that uses almost none of them is opened once, then again with the network taken away, and the whole kernel is asked for.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { watchErrors } from "../page-errors.mjs";

const DIST = new globalThis.URL("../../dist/", import.meta.url);

export default async function ({ check, context, URL, errors }) {
  // ---- The list the build writes ----
  const listFile = new globalThis.URL("platform/parts.json", DIST);
  const listed = existsSync(listFile) ? JSON.parse(readFileSync(listFile, "utf8")).files : [];
  const built = readdirSync(new globalThis.URL("assets/", DIST)).filter((f) => /\.(js|css)$/.test(f)).map((f) => `/assets/${f}`);
  // dist/ may also hold files kept from earlier deploys (scripts/keep-assets.mjs), which the list leaves out: every listed file is there.
  const missing = listed.filter((file) => !existsSync(new globalThis.URL(`.${file}`, DIST)));
  const modules = built.filter((f) => /\/kernel-[a-z-]+-/.test(f));
  check(
    "the build lists every part an app may fetch later: each kernel module, and the parts of the core and the page that load on demand",
    listed.length > 20 && !missing.length && modules.length > 10 && modules.every((f) => listed.includes(f)) && listed.some((f) => /\/review-card-/.test(f)) && listed.includes("/platform/drawing.js"),
    `${listed.length} listed, missing: ${missing.join(", ") || "none"}`,
  );

  // ---- A visit keeps them, and they work offline ----
  // At a name that isn't this machine's, as a visitor's would be: on localhost the worker leaves the parts alone (sw.js).
  const local = new globalThis.URL(URL);
  const SITE = `http://offline.localhost:${local.port}/`;
  const browser = await context.browser().browserType().launch({ args: [`--host-resolver-rules=MAP offline.localhost ${local.hostname}`] });
  try {
    const own = await browser.newContext();
    // A blank tab keeps the browser context, and what it has kept, while the app's own tab is closed.
    await own.newPage();
    const page = await own.newPage();
    watchErrors(page, errors, "offline-parts");
    await page.goto(`${SITE}demos/habits/app.html`);
    await page.waitForSelector('[data-key="habits:habits"] ui-form', { timeout: 15000 });
    const started = await page.evaluate(() => window.__host.command("modules")).then((all) => all.filter((m) => m.running).map((m) => m.name));
    // The worker waits a few seconds, so the page's own loading comes first; then every listed file is kept.
    /** The listed files the worker hasn't kept yet, and whether it has kept the list itself (which it does last). */
    const notKept = () =>
      page.evaluate(async (files) => {
        const cache = await caches.open("platform-v1");
        const there = await Promise.all(files.map((file) => cache.match(file, { ignoreVary: true })));
        return { list: !!(await cache.match("/platform/parts.json")), missing: files.filter((_file, i) => !there[i]) };
      }, listed);
    let left = await notKept();
    for (let waited = 0; (!left.list || left.missing.length) && waited < 45000; waited += 500) {
      await page.waitForTimeout(500);
      left = await notKept();
    }
    const kept = left.list && !left.missing.length;
    check("some seconds after a first visit, the service worker has kept every listed part, used or not", kept, `not kept: ${left.missing.join(", ") || "only the list"}; the kernel had started: ${started.join(", ")}`);

    // The next visit: its kernel starts under the service worker, which answers what the kernel fetches. (The first
    // visit's kernel started before there was a worker, so its own fetches go to the network to the end of that visit.)
    await page.close();
    const next = await own.newPage();
    watchErrors(next, errors, "offline-parts");
    await next.goto(`${SITE}demos/habits/`);
    await next.waitForSelector('[data-key="habits:habits"] ui-form', { timeout: 15000 });
    await own.setOffline(true);
    // The reference describes the whole kernel: its own code is a part, and it starts every module the site lists.
    const reference = await next.evaluate(() => window.__host.command("reference").then((r) => ({ ok: true, length: r.markdown.length }), (e) => ({ ok: false, error: String(e?.message ?? e) })));
    const running = await next.evaluate(() => window.__host.command("modules")).then((all) => all.filter((m) => !m.running).map((m) => m.name));
    const failed = await next.evaluate(() => window.__host.traces.filter((e) => e.name === "module:failed").map((e) => `${e.plugin}: ${e.detail}`));
    check(
      "offline, parts this visit never used still load: the reference is written and every kernel module starts",
      reference.ok && reference.length > 5000 && started.length < 5 && !running.length && !failed.length,
      JSON.stringify({ reference, notRunning: running, failed }).slice(0, 400),
    );
    await own.setOffline(false);
    await own.close();
  } finally {
    await browser.close();
  }
}
