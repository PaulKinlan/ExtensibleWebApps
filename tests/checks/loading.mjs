// Loading fast without jumping (docs/guide/loading-fast.md): hashed platform scripts are kept,
// template files load before their plugin draws, views wait for their elements, each slot's height
// is remembered and held on the next visit, and same-site links are prefetched.
import { watchErrors } from "../page-errors.mjs";
import { readFileSync } from "node:fs";

export default async function ({ check, context, URL, errors }) {
  const headers = readFileSync(new globalThis.URL("../../public/_headers", import.meta.url), "utf8");
  check("the hashed platform scripts in /assets/ are kept as immutable", /^\/assets\/\*\n\s+Cache-Control:[^\n]*immutable/m.test(headers));

  const own = await context.browser().newContext({ viewport: { width: 1280, height: 900 } });
  const page = await own.newPage();
  watchErrors(page, errors, "loading");
  // Every ui-* element in a view, when the view first goes into the page.
  await page.addInitScript(() => {
    window.__undefinedAtDraw = [];
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && n.dataset?.key) for (const el of n.querySelectorAll("*")) if (el.localName.startsWith("ui-") && !customElements.get(el.localName)) window.__undefinedAtDraw.push(`${n.dataset.key}: ${el.localName}`);
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(`${URL}demos/reading-list/app.html`);
  await page.waitForSelector('[data-key="library:books"] ui-table', { timeout: 10000 });
  const early = await page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.endsWith("/demos/reading-list/library.html")));
  check("a plugin's template file is fetched", early);
  const undefinedAtDraw = await page.evaluate(() => window.__undefinedAtDraw);
  check("a view goes into the page once the ui-* elements it uses are defined", !undefinedAtDraw.length, undefinedAtDraw.slice(0, 5).join(", "));
  check("the page offers its links to the browser to prefetch", await page.evaluate(() => !HTMLScriptElement.supports?.("speculationrules") || !!document.querySelector('script[type="speculationrules"]')));
  // The views settle, and their slots' heights are kept for the next visit.
  const kept = await page.waitForFunction(() => { const kept = JSON.parse(localStorage.getItem("ewa:slot-heights:demos/reading-list") ?? "{}"); return Object.keys(kept).some((k) => k.startsWith("main@")) && kept; }, null, { timeout: 10000 }).then((h) => h.jsonValue(), () => ({}));
  const main = Object.entries(kept).find(([k]) => k.startsWith("main@"));
  check("a slot's height is remembered once its views settle", !!main && main[1] > 50, JSON.stringify(kept));

  // The next visit holds that room until the views are drawn: the slot's content and spacer together
  // are at least as tall from the start, so the aside's views don't move down as the main ones arrive.
  const again = await own.newPage();
  await again.addInitScript(() => {
    window.__shifts = 0;
    window.__held = false;
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains("slot-reserve") && n.closest("main")) window.__held = true;
    }).observe(document, { childList: true, subtree: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shifts += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await again.goto(`${URL}demos/reading-list/app.html`);
  const spacer = await again.evaluate(() => window.__held);
  check("on the next visit a slot holds its room while its plugins start", spacer);
  await again.waitForSelector('[data-key="library:books"] ui-table', { timeout: 10000 });
  await again.waitForTimeout(1500);
  const shifts = await again.evaluate(() => window.__shifts);
  check("the next visit's page barely moves while it fills in (layout shift under 0.05)", shifts < 0.05, shifts.toFixed(3));
  const released = await again.waitForFunction(() => !document.querySelector(".slot-reserve"), null, { timeout: 10000 }).then(() => true, () => false);
  check("the held room goes once the views have settled", released);
  await own.close();
}
