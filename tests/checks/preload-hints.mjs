// Every app page in the build names the files its first view needs (sw/preload-hints.js, vite.preload.ts).
//
// Without the hints a visit finds its files one after another: the page, the host, each plugin, its template, the
// elements the template uses, each element's script. With them the browser asks for all of them as the page
// arrives. Four things are checked:
//
//   - the build put the hints in every app page, each names a file that is there, and the pages in the repo have none
//   - the writer itself: making them twice changes nothing, taking them out gives the page back, and a page that
//     isn't an app is left alone
//   - in a browser, every hinted file was used: an unused preload is a wasted request, and Chrome says so
//   - a page the service worker answers from what it kept comes without them, since there they only add work
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { hintsFor, withHints, withoutHints } from "../../sw/preload-hints.js";
import { watchErrors } from "../page-errors.mjs";

const ROOT = new globalThis.URL("../../", import.meta.url);
const DIST = new globalThis.URL("dist/", ROOT);
const HINT = /<link\b[^>]*\bdata-preload\b[^>]*>/gi;

export default async function ({ check, context, URL, errors }) {
  // ---- What the build wrote ----
  const platform = JSON.parse(readFileSync(new globalThis.URL("platform/preload.json", DIST), "utf8"));
  const demos = readdirSync(new globalThis.URL("demos/", ROOT), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(new globalThis.URL(`demos/${d.name}/app.html`, ROOT))).map((d) => `demos/${d.name}/app.html`);
  const pages = [...demos, "index.html", "workbench/index.html"];
  const problems = [];
  let hinted = 0;
  let withRuntime = 0;
  for (const page of pages) {
    const html = readFileSync(new globalThis.URL(page, DIST), "utf8");
    const lines = html.match(HINT) ?? [];
    hinted += lines.length;
    if (!lines.some((line) => line.includes(platform.kernel.slice(1)))) problems.push(`${page}: the kernel isn't hinted`);
    // The plugin runtime, for a page with a plugin that starts at once (Trip has none of its own, and others only ones that wait).
    if (lines.some((line) => line.includes(platform.runtime.slice(1)))) withRuntime++;
    else if (page === "demos/habits/app.html") problems.push(`${page}: the plugin runtime isn't hinted`);
    for (const line of lines) {
      const href = /href="([^"]+)"/.exec(line)?.[1] ?? "";
      const file = new globalThis.URL(href, new globalThis.URL(page, "http://site/")).pathname;
      if (!existsSync(new globalThis.URL(`.${file}`, DIST))) problems.push(`${page}: ${href} isn't in the build`);
    }
    if ((readFileSync(new globalThis.URL(page.startsWith("demos/") ? page : `site/${page}`, ROOT), "utf8").match(HINT) ?? []).length) problems.push(`${page}: the page in the repo has hints written into it`);
  }
  check(
    "the build names, in every app page, the files its first view needs: the kernel, the plugin runtime, each plugin, template and element, all of them there, and none written into the repo's pages",
    pages.length > 20 && withRuntime > 15 && platform.kernel && platform.runtime && !problems.length,
    problems.length ? problems.slice(0, 6).join("; ") : `${hinted} hints in ${pages.length} pages`,
  );

  // ---- The writer ----
  const files = {
    "/app/app.html": '<!doctype html>\n<html>\n<head>\n  <link rel="plugin" href="notes.js">\n  <script type="module" src="/platform/host.js"></script>\n</head>\n<body></body>\n</html>\n',
    "/app/notes.js": '// It\'s a plugin.\nexport const manifest = { id: "notes", name: "Notes", version: "1.0.0", permissions: ["ui"], services: ["commands"] };\nexport default (ctx) => ctx.ui.views("notes.html");\n',
    "/app/notes.html": '<template data-view="list"><ui-card><ui-badge></ui-badge></ui-card></template>',
    "/elements/ui-card.html": '<template><ui-spacer></ui-spacer></template><script type="module" src="ui-card.js"></script>',
    "/elements/ui-badge.html": "<template><slot></slot></template>",
    "/elements/ui-spacer.html": "<template></template>",
    "/std/customize.js": 'export const manifest = { id: "customize", name: "Customize", version: "1.0.0", standIn: {}, code: "customize.code.js" };',
  };
  const read = async (path) => files[path];
  const known = { kernel: "/assets/browser-aaaaaaaa.js", runtime: "/assets/runtime-aaaaaaaa.js", netRuntime: "/assets/net-runtime-aaaaaaaa.js", agents: [], modules: { commands: ["/assets/kernel-commands-aaaaaaaa.js"] } };
  const made = await withHints(files["/app/app.html"], "/app/app.html", read, known);
  const hrefs = (await hintsFor(files["/app/app.html"], "/app/app.html", read, known)).map((h) => `${h.as} ${h.href}`);
  const wanted = ["module /assets/browser-aaaaaaaa.js", "module /assets/runtime-aaaaaaaa.js", "module /assets/kernel-commands-aaaaaaaa.js", "fetch /app/notes.js", "fetch /std/customize.js", "fetch /app/notes.html", "fetch /elements/ui-card.html", "fetch /elements/ui-badge.html", "fetch /elements/ui-spacer.html", "module /elements/ui-card.js"];
  const absent = wanted.filter((w) => !hrefs.includes(w));
  check(
    "the writer follows a page to its plugin, the plugin's template, the elements in it and inside those, an element's script, and the kernel module the manifest names; and not the network runtime no plugin asked for",
    !absent.length && !hrefs.some((h) => h.includes("net-runtime")) && made.includes('href="notes.js" data-preload') && made.indexOf("data-preload") > made.indexOf("/platform/host.js"),
    absent.length ? `not hinted: ${absent.join(", ")}` : hrefs.join(", "),
  );
  const plain = "<!doctype html><html><head><title>About</title></head><body><p>Not an app.</p></body></html>";
  const based = await withHints(files["/app/app.html"].replace("<head>", '<head>\n  <base href="/app/">'), "/app/app.html", read, known);
  check(
    "making the hints twice changes nothing, taking them out gives the page back, a page with a <base> names its files from the root, and a page that isn't an app is left as it was",
    (await withHints(made, "/app/app.html", read, known)) === made && withoutHints(made) === files["/app/app.html"] && based.includes('href="/app/notes.js" data-preload') && (await withHints(plain, "/about.html", read, known)) === plain,
  );

  // ---- In a browser: nothing hinted goes unused ----
  // Each app in a browser profile of its own: a first visit, which no service worker answers, is what the hints are for.
  const unused = [];
  let inPage = 0;
  const browser = await context.browser().browserType().launch({ args: [`--host-resolver-rules=MAP hints.localhost ${new globalThis.URL(URL).hostname}`] });
  try {
    for (const app of ["demos/habits/app.html", "demos/assistant/app.html", "demos/markdown-editor/app.html"]) {
      const fresh = await browser.newContext();
      const page = await fresh.newPage();
      watchErrors(page, errors, "preload-hints");
      page.on("console", (message) => /preload/i.test(message.text()) && unused.push(`${app}: ${message.text().slice(0, 160)}`));
      await page.goto(`${URL}${app}`);
      await page.waitForSelector('[data-key]:not([data-key^="customize:"])', { state: "attached", timeout: 15000 });
      // Chrome says a preload went unused a few seconds after the page has loaded.
      await page.waitForTimeout(4500);
      inPage += await page.evaluate(() => document.querySelectorAll("link[data-preload]").length);
      await fresh.close();
    }
    check("on a first visit every hinted file is used by the page: Chrome reports no preload that went unused, on an app, an agent's app and one with a network plugin", inPage > 30 && !unused.length, unused.slice(0, 5).join("; ") || `${inPage} hints in three pages`);

    // ---- Answered by the service worker: no hints, and the worker asks for the files itself ----
    // At a name that isn't this machine's, as a visitor's would be: on localhost the worker asks the network first (sw.js).
    const local = new globalThis.URL(URL);
    const SITE = `http://hints.localhost:${local.port}/`;
    const own = await browser.newContext();
    const first = await own.newPage();
    watchErrors(first, errors, "preload-hints");
    await first.goto(`${SITE}demos/habits/app.html`);
    await first.waitForSelector('[data-key="habits:habits"] ui-form', { timeout: 15000 });
    const firstHints = await first.evaluate(() => document.querySelectorAll("link[data-preload]").length);
    await first.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
    // Until the worker has kept the page (asked from here: a page's own wait can't wait on a promise).
    for (let waited = 0; waited < 15000; waited += 200) {
      if (await first.evaluate(async () => !!(await (await caches.open("platform-v1")).match(new URL("app.html", location.href).pathname)))) break;
      await first.waitForTimeout(200);
    }
    await first.close();
    const next = await own.newPage();
    watchErrors(next, errors, "preload-hints");
    await next.goto(`${SITE}demos/habits/`);
    await next.waitForSelector('[data-key="habits:habits"] ui-form', { timeout: 15000 });
    const nextHints = await next.evaluate(() => document.querySelectorAll("link[data-preload]").length);
    // And the view answers: the form is the real element, not markup waiting for its script.
    const answers = await next.evaluate(() => !!customElements.get("ui-form") && !!document.querySelector('[data-key="habits:habits"] ui-form'));
    check("a first visit's page has the hints; the next visit, answered from what the service worker kept, comes without them and its view is live", firstHints > 5 && nextHints === 0 && answers, `first visit ${firstHints}, next visit ${nextHints}`);
    // Another app, for the first time, in the same browser: the worker answers its page from the network, without
    // the hints, and fetches what they named itself. Each of the app's files crosses the network once.
    const other = await own.newPage();
    watchErrors(other, errors, "preload-hints");
    other.on("console", (message) => /preload/i.test(message.text()) && unused.push(message.text().slice(0, 160)));
    await other.goto(`${SITE}demos/contacts/app.html`);
    await other.waitForSelector('[data-key]:not([data-key^="customize:"])', { state: "attached", timeout: 15000 });
    await other.waitForTimeout(4500);
    const otherHints = await other.evaluate(() => document.querySelectorAll("link[data-preload]").length);
    const timing = await other.evaluate(() => performance.getEntriesByType("resource").filter((e) => /\/demos\/contacts\/people\.(js|html)$/.test(e.name)).map((e) => Math.round(e.startTime)));
    check("an app opened for the first time under the service worker comes without hints too, with no preload unused: the worker fetched what they named", otherHints === 0 && !unused.length && timing.length >= 2, `${otherHints} hints; ${unused.slice(0, 3).join("; ")}; its plugin and template asked for at ${timing.join(", ")} ms`);
    await own.close();
  } finally {
    await browser.close();
  }
}
