// Kernel modules that start late (src/kernel/modules.ts): a module's file is
// fetched the first time something it adds is used, which can be long after
// the tabs opened. A module that needs to know where each tab is must still
// find out. Checked here, in a kernel of its own, with an app (Habits) that
// uses none of these modules:
//
// - the router, started by a plugin installed later, already knows the screen
//   the tab was opened at (the kernel replays each tab's address to it);
// - share, started after its tab is already at the share screen, still has
//   what was shared, and hands it over once;
// - a plugin asks for history in an app that never listed it, and gets it;
// - the files of the modules an app used, one started late included, come
//   from the service worker's cache when the network is gone.
import { watchErrors } from "../page-errors.mjs";

export default async function ({ check, context, URL: site, errors }) {
  const fresh = await context.browser().newContext();
  const page = await fresh.newPage();
  watchErrors(page, errors, "late-modules");
  const running = async () => (await page.evaluate(() => window.__host.command("modules"))).filter((m) => m.running).map((m) => m.name).sort();
  const started = async () => {
    await page.waitForFunction(() => window.__host?.traces.some((e) => e.name === "kernel:start"), null, { timeout: 15000 });
    await page.waitForTimeout(500);
  };
  const install = (src) => page.evaluate((source) => window.__host.command("install", source), src);
  const log = (id, prefix) =>
    page
      .waitForFunction(([i, p]) => window.__host.traces.findLast((e) => e.plugin === i && e.detail?.startsWith(p))?.detail, [id, prefix], { timeout: 10000 })
      .then((h) => h.jsonValue(), () => "");
  try {
    // Through the service worker, so /shelf/3 and /share are screens of the app.
    await page.goto(`${site}demos/habits/app.html`);
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("load");

    // ---- The router hears where a tab already is ----
    await page.goto(`${site}demos/habits/shelf/3?view=grid`);
    await started();
    const before = await running();
    const installed = await install(`export const manifest = { id: 'late-router', name: 'Late router', permissions: ['router'] };
export default async (ctx) => { ctx.log('late-router ' + JSON.stringify(await ctx.call('router', 'current'))); };`);
    const at = await log("late-router", "late-router ");
    check(
      "a router that starts after the tab opened knows the screen the tab is at",
      installed.ok && /"path":"\/shelf\/3"/.test(at) && /"view":"grid"/.test(at) && (await running()).includes("router"),
      `${at || JSON.stringify(installed)}; running before: ${before.join(", ") || "none"}`,
    );

    // ---- Share starts after its tab is at the share screen ----
    await page.evaluate(() => window.__host.command("uninstall", "late-router")).catch(() => {});
    await page.goto(`${site}demos/habits/share?title=${encodeURIComponent("Shared late")}&url=${encodeURIComponent("https://example.com/late")}`);
    await started();
    const beforeShare = await running();
    await install(`export const manifest = { id: 'late-share', name: 'Late share', permissions: ['share'] };
export default async (ctx) => {
  ctx.log('late-share ' + JSON.stringify(await ctx.call('share', 'take')));
  ctx.log('late-share-again ' + JSON.stringify(await ctx.call('share', 'take')));
};`);
    const took = await log("late-share", "late-share ");
    const again = await log("late-share", "late-share-again ");
    const back = await page.waitForFunction(() => location.pathname === "/demos/habits/", null, { timeout: 5000 }).then(() => true, () => false);
    check(
      "share, started after its tab was already at the share screen, still has what was shared, once, and the tab goes back to the app",
      took === 'late-share {"title":"Shared late","url":"https://example.com/late"}' && again === "late-share-again null" && back,
      `${took}; ${again}; at ${new globalThis.URL(page.url()).pathname}; share running before: ${beforeShare.includes("share")}`,
    );
    await page.evaluate(() => window.__host.command("uninstall", "late-share")).catch(() => {});

    // ---- History for a plugin in an app that never listed it ----
    // It keeps what is written from when it starts, so the plugin asks for it first, then writes.
    await install(`export const manifest = { id: 'late-history', name: 'Late history', permissions: ['history'], collections: { 'late-jobs': { title: 'Jobs', schema: { type: 'object', properties: { title: { type: 'string' } } } } } };
export default async (ctx) => {
  await ctx.call('history', 'state');
  const { id } = await ctx.call('data', 'put', 'late-jobs', { title: 'Paint the fence' });
  await ctx.call('data', 'put', 'late-jobs', { id, title: 'Paint the shed' });
  const state = await ctx.call('history', 'state');
  await ctx.call('history', 'undo');
  ctx.log('late-history ' + JSON.stringify({ undo: state.undo?.text, title: (await ctx.call('data', 'get', 'late-jobs', id))?.title }));
};`);
    const history = await log("late-history", "late-history ");
    check("a plugin can ask for history in an app that never listed it: it starts, and undoes what is written from then on", /"title":"Paint the fence"/.test(history) && /Paint the shed/.test(history), history || "no answer");
    await page.evaluate(() => window.__host.command("uninstall", "late-history")).catch(() => {});
  } finally {
    await fresh.close();
  }

  // ---- A module's file, offline ----
  // Another kernel, and a first visit, at the app's page itself (app.html): the page loads before the service worker is there, so the kernel says which
  // module files it fetched and the worker keeps them (src/host/service-worker.ts), a late one included.
  const visit = await context.browser().newContext();
  const HABITS = '[data-key="habits:habits"] ui-form';
  const open = async () => {
    const page = await visit.newPage();
    watchErrors(page, errors, "late-modules offline");
    const opened = await page.goto(`${site}demos/habits/app.html`).then(() => page.waitForSelector(HABITS, { timeout: 15000 })).then(() => true, () => false);
    return { page, opened };
  };
  const runningIn = async (page) => (await page.evaluate(() => window.__host.command("modules"))).filter((m) => m.running).map((m) => m.name).sort();
  try {
    // A blank tab keeps the browser context while the app's own tab is closed.
    await visit.newPage();
    const first = await open();
    // A module started late, after the page first told the worker what to keep: debug, by its bench command.
    await first.page.evaluate(() => window.__host.command("bench", 5));
    const online = await runningIn(first.page);
    // The page asks the kernel again 3 seconds after its first list, for files like that one. Wait until the worker
    // has kept everything the page and its kernel fetched, however long this machine takes.
    const notKept = () =>
      first.page.evaluate(async () => {
        const kept = new Set((await (await caches.open("platform-v1")).keys()).map((r) => r.url));
        const fetched = [location.href, ...performance.getEntriesByType("resource").map((e) => e.name), ...(await window.__host.command("fetched")).map((u) => new URL(u, location.href).href)];
        return [...new Set(fetched)].filter((u) => u.startsWith(location.origin) && !kept.has(u) && !/\/(s|auth)\//.test(u)).map((u) => new URL(u).pathname);
      });
    let missing = await notKept();
    for (let waited = 0; missing.length && waited < 30000; waited += 500) {
      await first.page.waitForTimeout(500);
      missing = await notKept();
    }
    // The last tab closes, so the kernel stops: the next tab's kernel starts with no module's file in memory.
    await first.page.close({ runBeforeUnload: true });
    await visit.setOffline(true);
    const { page, opened } = await open();
    const bench = opened ? await page.evaluate(() => window.__host.command("bench", 5)).catch((e) => ({ error: String(e.message ?? e).split("\n")[0] })) : { error: "the app didn't open offline" };
    const offline = opened ? await runningIn(page) : [];
    const failed = opened ? await page.evaluate(() => window.__host.traces.filter((e) => e.name === "module:failed").map((e) => `${e.plugin}: ${e.detail}`)) : [];
    check(
      "offline, an app opened once at its app.html opens again and starts every kernel module it used, a late one too: their files are kept by the service worker",
      opened && bench?.n === 5 && online.length > 0 && online.every((name) => offline.includes(name)) && !failed.length,
      `online: ${online.join(", ")}; offline: ${offline.join(", ")}${missing.length ? `; never kept: ${missing.join(" ")}` : ""}${bench?.error ? `; bench: ${bench.error}` : ""}${failed.length ? `; ${failed.join("; ")}` : ""}`,
    );
  } finally {
    await visit.setOffline(false).catch(() => {});
    await visit.close();
  }
}
