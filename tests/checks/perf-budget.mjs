// The performance budget (tests/perf-budget.json), so a change that makes the
// platform heavier or slower fails CI instead of being noticed later:
//
//   - bytes: the built platform files every app loads, gzipped as a host sends them
//   - first view: from navigation until an app's first plugin view is in the
//     page, on a first visit and on the next one (the service worker answering)
//   - layout shift: how far the page moves while it fills in, on the next visit
//
// The times are generous for a busy CI runner: they catch a change that makes
// loading slower by a lot (a runtime file no longer kept, a plugin's views
// waiting on another), not one by a little. The measured numbers go in the
// run's Measurements, to see the trend. To change a budget, change the JSON
// file and say why in the PR. docs/guide/loading-fast.md is how pages load fast.
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";

const budget = JSON.parse(readFileSync(new globalThis.URL("../perf-budget.json", import.meta.url), "utf8"));
const DIST = new globalThis.URL("../../dist/", import.meta.url);

export default async function ({ check, context, URL, errors, measurements }) {
  // Bytes: each file named in the budget, found in the build by its name before the hash.
  const sizes = {};
  for (const [name, limit] of Object.entries(budget.gzipKB)) {
    const [folder, base] = name.split("/");
    const file = readdirSync(new globalThis.URL(`${folder}/`, DIST)).find((f) => f === base || f.replace(/-[\w-]{8}\.js$/, ".js") === base);
    const kb = file ? Math.round(gzipSync(readFileSync(new globalThis.URL(`${folder}/${file}`, DIST))).length / 102.4) / 10 : Infinity;
    sizes[name] = kb;
    check(`budget: ${name} is at most ${limit} KB gzipped`, kb <= limit, `${kb} KB`);
  }
  measurements.gzipKB = sizes;

  // Times: each app opened in a fresh browser profile, then again.
  const times = {};
  for (const [app, view] of Object.entries(budget.apps)) {
    const own = await context.browser().newContext({ viewport: { width: 1280, height: 900 } });
    const page = await own.newPage();
    page.on("pageerror", (e) => errors.push(`perf-budget ${app}: ${e.message}`));
    await page.addInitScript(() => {
      window.__shift = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shift += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    });
    const firstView = async () => {
      await page.waitForSelector(view, { timeout: 15000 });
      return page.evaluate(() => Math.round(performance.now()));
    };
    // A first visit: 404.html for a folder starts the service worker, so it is timed at app.html.
    await page.goto(`${URL}${app}app.html`);
    const first = await firstView().catch(() => Infinity);
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.goto(`${URL}${app}`);
    const again = await firstView().catch(() => Infinity);
    await page.waitForTimeout(1000);
    const shift = await page.evaluate(() => Math.round(window.__shift * 1000) / 1000);
    times[app] = { first, again, shift };
    await own.close();
    check(`budget: ${app}'s first view is in the page within ${budget.firstViewMs.first} ms on a first visit`, first <= budget.firstViewMs.first, `${first} ms`);
    check(`budget: ${app}'s first view is in the page within ${budget.firstViewMs.again} ms on the next visit`, again <= budget.firstViewMs.again, `${again} ms`);
    check(`budget: ${app} moves less than ${budget.layoutShift} (layout shift) as it fills in on the next visit`, shift <= budget.layoutShift, String(shift));
  }
  measurements.loading = times;
}
