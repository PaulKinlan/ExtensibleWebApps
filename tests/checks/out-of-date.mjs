// A deploy never breaks a page that is already open.
//
// The built platform scripts have their content's hash in their names, and a page opened before a deploy asks
// for its own older ones (a kernel module, the reference) the first time it needs them. Three things hold:
//
//   - each build keeps the previous deploy's files (scripts/keep-assets.mjs), so they are still there;
//   - a part that can't be fetched all the same says so in words a person can act on (src/kernel/part.ts);
//   - the service worker then tells the page it is out of date, forgets what it kept so a reload is the
//     site as it is now, and reloads a page with no host to hear it (sw.js).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { keepAssets, siteFor, KEEP_DAYS, LIST } from "../../scripts/keep-assets.mjs";
import { watchErrors } from "../page-errors.mjs";

export default async function ({ check, context, URL, WORKBENCH, errors }) {
  // ---- The build keeps the last deploy's files ----
  const dist = mkdtempSync(join(tmpdir(), "keep-assets-"));
  try {
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets", "browser-NEW.js"), "new kernel");
    writeFileSync(join(dist, "assets", "runtime-SAME.js"), "same runtime");
    const today = new Date("2026-11-10T12:00:00Z");
    const ago = (days) => new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
    /** A live site: its list, and the files it still serves. Anything else is its not-found page. */
    const site = (list, served, asked = []) => async (url) => {
      const path = new globalThis.URL(url).pathname.slice(1);
      asked.push(path);
      if (path === LIST && list !== undefined) return new Response(typeof list === "string" ? list : JSON.stringify({ files: list }));
      if (path in served) return new Response(served[path]);
      return new Response("<!doctype html>Not found", { status: 404, headers: { "content-type": "text/html" } });
    };
    const asked = [];
    const live = { "browser-OLD.js": ago(1), "reference-OLD.js": ago(1), "runtime-SAME.js": ago(1), "kernel-llm-ANCIENT.js": ago(KEEP_DAYS + 5), "kernel-llm-LOST.js": ago(3) };
    const served = { "assets/browser-OLD.js": "old kernel", "assets/reference-OLD.js": "old reference", "assets/kernel-llm-ANCIENT.js": "ancient" };
    const done = await keepAssets({ dist, site: "https://site.example/", today, fetcher: site(live, served, asked), wait: 1 });
    const list = JSON.parse(readFileSync(join(dist, LIST), "utf8")).files;
    check(
      "a build brings along the files the last deploy served that it no longer makes, so a page already open can still fetch them",
      readFileSync(join(dist, "assets", "reference-OLD.js"), "utf8") === "old reference" && readFileSync(join(dist, "assets", "browser-OLD.js"), "utf8") === "old kernel" && done.kept.length === 2,
      JSON.stringify(done),
    );
    check(
      "the list it writes has each file with the day it was last part of a build: today's for this build's, the old day for a kept one",
      list["browser-NEW.js"] === ago(0) && list["runtime-SAME.js"] === ago(0) && list["reference-OLD.js"] === ago(1) && !("kernel-llm-ANCIENT.js" in list) && !("kernel-llm-LOST.js" in list),
      JSON.stringify(list),
    );
    check(
      `a file last built more than ${KEEP_DAYS} days ago is left behind without being fetched, and one the site has already lost is said, not fatal`,
      !existsSync(join(dist, "assets", "kernel-llm-ANCIENT.js")) && !asked.includes("assets/kernel-llm-ANCIENT.js") && done.dropped === 1 && done.gone.join() === "kernel-llm-LOST.js",
      JSON.stringify({ asked, done }),
    );

    const outcome = (options) => keepAssets({ dist, today, wait: 1, ...options }).then((did) => ({ did }), (error) => ({ error: error.message }));
    const first = await outcome({ site: "https://site.example/", fetcher: site(undefined, {}) });
    check("a site with no list yet (its first deploy that keeps files) has nothing to keep, and the build goes on", first.did?.kept.length === 0, JSON.stringify(first));
    const down = await outcome({ site: "https://site.example/", fetcher: async () => new Response("busy", { status: 503 }) });
    const unreachable = await outcome({ site: "https://site.example/", fetcher: async () => Promise.reject(new Error("no route")) });
    const nonsense = await outcome({ site: "https://site.example/", fetcher: site("<html>", {}) });
    const sneaky = await outcome({ site: "https://site.example/", fetcher: site({ "../../wrangler.jsonc": ago(1) }, {}) });
    check(
      "a site that can't be asked, or whose list is wrong, stops the build: a deploy never quietly drops the old files",
      /answered 503/.test(down.error) && /no route/.test(unreachable.error) && /isn't JSON/.test(nonsense.error) && /isn't a built file's name/.test(sneaky.error),
      JSON.stringify({ down, unreachable, nonsense, sneaky }),
    );
    const local = await outcome({ fetcher: async () => Promise.reject(new Error("the network was asked")) });
    check("away from a deploy the build asks no site: it only writes the list", local.did?.kept.length === 0 && siteFor({}) === undefined && siteFor({ WORKERS_CI: "1" }) === "https://extensibleweb.app/", JSON.stringify(local));
    const unknown = (() => {
      try {
        return siteFor({ KEEP_ASSETS_FROM: "not an address" });
      } catch (error) {
        return error.message;
      }
    })();
    check("a site address that isn't one stops the build", /isn't a site's address/.test(String(unknown)), String(unknown));
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
  const builtList = JSON.parse(readFileSync(fileURLToPath(new globalThis.URL(`../../dist/${LIST}`, import.meta.url)), "utf8")).files;
  const assets = fileURLToPath(new globalThis.URL("../../dist/assets/", import.meta.url));
  check("`npm run build` writes the list of this build's files, where the next deploy asks for it", readdirSync(assets).every((name) => name in builtList), `${Object.keys(builtList).length} files`);

  // ---- A page whose older part has gone ----
  // A browser of its own: its kernel hasn't fetched the reference yet. The reference's file is taken away, as a
  // deploy older than the kept files would have, then a plugin asks for the reference, as Ask the page does.
  const own = await context.browser().newContext();
  const reference = readdirSync(assets).find((name) => /^reference-.*\.js$/.test(name));
  const away = join(assets, `${reference}.away`);
  try {
    const page = await own.newPage();
    watchErrors(page, errors, "out-of-date");
    await page.goto(WORKBENCH);
    await page.waitForFunction(() => window.__host && navigator.serviceWorker.controller, null, { timeout: 10000 });
    // Again, so the kernel's own requests go through the service worker too.
    await page.goto(WORKBENCH);
    await page.waitForFunction(() => window.__host?.traces.some((e) => e.name === "plugin:ready"), null, { timeout: 10000 });
    renameSync(join(assets, reference), away);
    const asker = `export const manifest = { id: 'old-page-asker', name: 'Old page asker', permissions: ['ui'] };
export default async (ctx) => {
  const said = await ctx.call('kernel', 'reference').then(() => 'It loaded', (e) => e.message);
  ctx.ui.render('status', 'said', { type: 'text', text: 'asker: ' + said });
};`;
    await page.evaluate((source) => window.__host.command("install", source), asker);
    const said = await page.waitForSelector("footer >> text=asker:", { timeout: 10000 }).then((el) => el.textContent(), () => "");
    check(
      "a part of an older version that has gone says what happened and what to do, not \"Failed to fetch dynamically imported module\"",
      /Couldn't load the kernel's reference/.test(said) && /Reload the page/.test(said) && !/dynamically imported/.test(said) && !/assets\//.test(said),
      said,
    );
    const told = await page.waitForSelector("#out-of-date button", { timeout: 8000 }).then(() => page.textContent("#out-of-date"), () => "");
    check("the page says it is older than the site and offers a reload, and stays until the person chooses", /older than the site/.test(told) && /Reload/.test(told), told);
    await page.waitForTimeout(500);
    const forgotten = await page.evaluate(async () => (await (await caches.open("platform-v1")).keys()).map((r) => new URL(r.url).pathname).filter((path) => !path.startsWith("/assets/") && !path.startsWith("/__")));
    check("the service worker forgets the pages and scripts it kept, so the reload is the site as it is now", forgotten.length === 0, forgotten.slice(0, 5).join(", "));

    // The reload: the site as it is now has the part.
    renameSync(away, join(assets, reference));
    await Promise.all([page.waitForNavigation(), page.click("#out-of-date button")]);
    await page.waitForFunction(() => window.__host?.traces.some((e) => e.name === "plugin:ready"), null, { timeout: 10000 });
    await page.evaluate(() => window.__host.command("uninstall", "old-page-asker"));
    await page.evaluate((source) => window.__host.command("install", source), asker);
    const after = await page.waitForSelector("footer >> text=asker: It loaded", { timeout: 10000 }).then(() => true, () => false);
    check("after the reload the same question is answered", after && !(await page.$("#out-of-date")));
    await page.evaluate(() => window.__host.command("uninstall", "old-page-asker"));

    // A page whose own script is what failed has no host to hear the worker, so the worker loads it again.
    const bare = await own.newPage();
    await bare.goto(`${URL}${LIST}`);
    await bare.evaluate(() => {
      window.__before = true;
      void fetch("/assets/host-part-GONE.js");
    });
    const reloaded = await bare.waitForFunction(() => !window.__before, null, { timeout: 8000 }).then(() => true, () => false);
    check("a page with nothing running that asked for a part that has gone is loaded again by the service worker", reloaded);
    await bare.evaluate(() => {
      window.__before = true;
      void fetch("/assets/host-part-GONE.js");
    });
    const again = await bare.waitForFunction(() => !window.__before, null, { timeout: 4000 }).then(() => true, () => false);
    check("and not a second time straight after: a page is never reloaded in a loop", !again);
  } finally {
    if (existsSync(away)) renameSync(away, join(assets, reference));
    await own.close();
  }
}
