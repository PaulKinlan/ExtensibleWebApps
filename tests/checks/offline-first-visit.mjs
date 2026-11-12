// A first visit that loses its server: the kernel's parts still arrive, and a command never hangs.
//
// The kernel fetches a part of itself the first time something asks for it (part.ts). Two things have to hold when
// the server can't be reached:
//
//   - On the very first visit, once the service worker has kept the parts (a few seconds in: sw/parts.js), the
//     kernel that visit started gets them from the worker. It was started before there was a worker, but the worker
//     claims it with the page (clients.claim, sw.js), so nobody has to come back a second time to be safe offline.
//   - Before the parts are kept, a part can't arrive. A command that needs one then answers { ok: false, error },
//     with words a person can act on, and the workbench shows them. It used to wait for ever.
//
// The server here is really gone, not marked offline in the browser: the page is reached through a small relay to
// the test's server, and the relay starts dropping every connection. (The browser's own offline switch doesn't
// reach a shared worker's fetches, so it would prove nothing about the kernel.)
import { existsSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { watchErrors } from "../page-errors.mjs";

const DIST = new globalThis.URL("../../dist/", import.meta.url);

export default async function ({ check, context, URL, errors }) {
  const target = new globalThis.URL(URL);
  /** gone: every connection is dropped. noParts: the list of parts isn't served, so the worker keeps none. */
  const state = { gone: false, noParts: false };
  const relay = createServer((req, res) => {
    if (state.gone) return void req.socket.destroy();
    if (state.noParts && req.url.startsWith("/platform/parts.json")) return void res.writeHead(503).end();
    const out = request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    out.on("error", () => res.destroy());
    req.pipe(out);
  });
  await new Promise((ready) => relay.listen(0, "127.0.0.1", ready));
  const SITE = `http://first-visit.localhost:${relay.address().port}/`;
  const listFile = new globalThis.URL("platform/parts.json", DIST);
  const listed = existsSync(listFile) ? JSON.parse(readFileSync(listFile, "utf8")).files : [];
  // At a name that isn't this machine's, as a visitor's would be: on localhost the worker leaves the parts alone (sw.js).
  const browser = await context.browser().browserType().launch({ args: ["--host-resolver-rules=MAP first-visit.localhost 127.0.0.1"] });
  /** A command's answer, or { hung: true } if none came in eight seconds. */
  const ask = (page, name) =>
    page.evaluate((name) => Promise.race([window.__host.command(name), new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 8000))]), name);
  try {
    // ---- Before the parts are kept: the command answers, saying why ----
    state.noParts = true;
    const early = await browser.newContext();
    const bench = await early.newPage();
    // The lost server is the point here, so the browser's own "failed to load" lines aren't errors of the page's.
    await bench.goto(`${SITE}workbench/`);
    await bench.waitForFunction(() => window.__host?.workers.size >= 11, null, { timeout: 15000 });
    await bench.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
    state.gone = true;
    const answer = await ask(bench, "reference");
    check(
      "with the server gone before the reference was ever fetched, the command answers with an error a person can act on instead of waiting",
      answer && !answer.hung && answer.ok === false && /Couldn't load the kernel's reference: the site couldn't be reached/.test(answer.error ?? "") && /try again/i.test(answer.error ?? ""),
      JSON.stringify(answer).slice(0, 300),
    );
    await bench.click("#reference");
    const shown = await bench.waitForFunction(() => /Couldn't load/.test(document.getElementById("reference-text")?.textContent ?? ""), null, { timeout: 8000 }).then(() => true, () => false);
    check("and the workbench's API reference button shows those words", shown, (await bench.textContent("#reference-text"))?.slice(0, 200));
    await early.close();

    // ---- Once the parts are kept: the first visit's own kernel gets them from the worker ----
    state.gone = false;
    state.noParts = false;
    const own = await browser.newContext();
    const page = await own.newPage();
    watchErrors(page, errors, "offline-first-visit");
    await page.goto(`${SITE}demos/habits/app.html`);
    await page.waitForSelector('[data-key="habits:habits"] ui-form', { timeout: 15000 });
    const started = await page.evaluate(() => window.__host.command("modules")).then((all) => all.filter((m) => m.running).map((m) => m.name));
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
    state.gone = true;
    const reference = await ask(page, "reference");
    const modules = await ask(page, "modules");
    const notRunning = Array.isArray(modules) ? modules.filter((m) => !m.running).map((m) => m.name) : ["(no answer)"];
    const failed = await page.evaluate(() => window.__host.traces.filter((e) => e.name === "module:failed").map((e) => `${e.plugin}: ${e.detail}`));
    check(
      "on a first visit, with the server gone once the parts are kept, the kernel that visit started still loads them: the reference is written and every module starts",
      left.list && !left.missing.length && started.length < 5 && reference?.markdown?.length > 5000 && !notRunning.length && !failed.length,
      JSON.stringify({ notKept: left.missing.length, started, reference: reference?.markdown ? reference.markdown.length : reference, notRunning, failed }).slice(0, 400),
    );
    await own.close();
  } finally {
    await browser.close();
    relay.close();
    relay.closeAllConnections?.();
  }
}
