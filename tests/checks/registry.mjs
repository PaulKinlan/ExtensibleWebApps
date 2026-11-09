// The plugin registry (packages/, docs/guide/plugin-registry.md): its index is
// current, Customize lists it, and adding a package from there adds the
// packages that provide the services it needs, so it starts.
import { readFileSync } from "node:fs";
import { buildIndex, render } from "../../scripts/packages.mjs";

export default async function ({ check, openTab, URL }) {
  const written = readFileSync(new globalThis.URL("../../packages/index.json", import.meta.url), "utf8");
  check("packages/index.json is what the packages' manifests say (run npm run packages)", written === render(await buildIndex()));

  const app = "demos/contacts";
  const page = await openTab(`${URL}${app}/app.html`);
  const list = () => page.evaluate((app) => window.__host.command("user:list", { app }), app);
  const turn = (id, on) => page.evaluate(([app, id, on]) => window.__host.command(on ? "user:on" : "user:off", { app, id }), [app, id, on]);
  try {
    await page.click("ui-panel .launch");
    const listed = await page.waitForSelector('[data-package="world-clock"]', { timeout: 8000 }).then(() => true, () => false);
    check("Customize lists the plugins in the site's registry", listed);
    await page.click('[data-package="world-clock"]');
    // Customize is a plugin, so each package it adds waits for the person to accept a review of its code.
    for (const name of ["adds Clock", "adds World clock"]) {
      await page.waitForSelector(`[data-key^="review:"] >> text=${name}`, { timeout: 15000 }).catch(() => {});
      await page.click('[data-key^="review:"] >> text=Accept', { timeout: 5000 }).catch(() => {});
    }
    // Waits for Customize to say it is done, rather than asking the kernel while it writes.
    const status = await page
      .waitForFunction(() => /^Added /.test(document.querySelector("ui-panel [role=status]")?.textContent ?? ""), null, { timeout: 20000 })
      .then(() => page.evaluate(() => document.querySelector("ui-panel [role=status]").textContent), () => "");
    const ids = (await list()).map((p) => p.id).sort();
    check("adding a package adds the package that provides the service it needs", ids.join() === "clock,world-clock" && /Clock and World clock/.test(status), `${ids.join()}: ${status}`);
    await turn("clock", true);
    await turn("world-clock", true);
    const time = await page
      .waitForFunction(() => /\d\d:\d\d/.test(document.querySelector(".world-clock strong")?.textContent ?? ""), null, { timeout: 10000 })
      .then(() => page.evaluate(() => document.querySelector(".world-clock")?.textContent?.replace(/\s+/g, " ").trim()), () => "");
    const why = time ? "" : await page.evaluate(() => JSON.stringify({ places: window.__host.places().filter((p) => p.plugin === "world-clock"), workers: [...window.__host.workers.keys()], trace: window.__host.traces.filter((e) => /clock/.test(JSON.stringify(e))).slice(-12) }));
    check("a registry plugin calls a service another registry plugin provides", /London\s*\d\d:\d\d/.test(time ?? ""), time || why);
  } finally {
    for (const id of ["world-clock", "clock"]) await page.evaluate(([app, id]) => window.__host.command("user:remove", { app, id }), [app, id]).catch(() => {});
    await page.close({ runBeforeUnload: true });
  }
}
