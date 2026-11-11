// The plugin registry (packages/, docs/guide/plugin-registry.md): its index,
// catalogue and page are current, the page lists every plugin the site ships
// and filters them, Customize lists the index, and adding a package from there
// adds the packages that provide the services it needs, so it starts.
import { execFileSync } from "node:child_process";
import { expected } from "../../scripts/packages.mjs";
import { PATHS } from "../../scripts/generated.mjs";

export default async function ({ check, openTab, context, URL }) {
  const want = await expected();
  for (const [name, text] of Object.entries(want)) {
    const served = await fetch(`${URL}packages/${name}`).then((r) => r.text(), () => "");
    check(`the build serves /packages/${name} made from the plugins' manifests`, served === text);
  }
  // Generated files are never committed, so pull requests can't conflict over them (scripts/generated.mjs).
  const tracked = execFileSync("git", ["ls-files", "--", ...PATHS.filter((p) => p.startsWith("packages/"))], { cwd: new globalThis.URL("../../", import.meta.url), encoding: "utf8" }).trim();
  check("the registry's generated files aren't committed (git rm them: the build makes them)", tracked === "", tracked);
  const { packages } = JSON.parse(want["index.json"]);
  const catalog = JSON.parse(want["catalog.json"]);
  check("the registry offers the language models, so a plugin that needs llm can get one", ["llm-anthropic", "llm-gemini", "llm-openai", "llm-openai-compatible"].every((id) => packages.some((p) => p.id === id && p.kind === "service")));
  check("Ask the page says which plugins can answer the llm it needs", packages.find((p) => p.id === "ask-the-page")?.needsOneOf?.llm?.length === 6);
  check("every offered plugin has a kind and a group", packages.every((p) => ["service", "ui", "background"].includes(p.kind) && p.group));
  check("the catalogue has every std plugin, every demo's plugins and the built-in services", catalog.plugins.some((p) => p.href === "/std/customize.js") && catalog.plugins.some((p) => p.href === "/demos/reading-list/library.js") && catalog.services.some((s) => s.id === "llm"));

  // The page: every plugin, the search narrows it, and the filters show one kind.
  // A plain page, not an app, so it has no window.__host for openTab to wait for.
  const listing = await context.newPage();
  try {
    await listing.goto(`${URL}packages/`);
    const all = await listing.locator("li.card").count();
    check("/packages/ shows every plugin and built-in service", all === catalog.plugins.length + catalog.services.length, `${all}`);
    await listing.fill("#find", "language model");
    await listing.waitForFunction(() => /^\d+ of /.test(document.querySelector(".shown")?.textContent ?? ""));
    const found = await listing.evaluate(() => [...document.querySelectorAll("li.card:not([hidden]) h4")].map((h) => h.firstChild.textContent.trim()));
    check("searching /packages/ finds the language models", found.includes("Claude (Anthropic)") && found.length < all, found.join(", "));
    await listing.fill("#find", "");
    await listing.click('[data-filter="service"]');
    const kinds = await listing.evaluate(() => [...new Set([...document.querySelectorAll("li.card:not([hidden])")].map((c) => c.dataset.kind))]);
    check("the Services filter shows only services", kinds.join() === "service", kinds.join());
  } finally {
    await listing.close();
  }

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
