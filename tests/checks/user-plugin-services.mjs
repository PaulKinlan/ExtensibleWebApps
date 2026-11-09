// A person's plugin that needs a service gets it from another plugin of
// theirs, never from the site's kernel.json (docs/layers.md, "When a person's
// plugin needs a service"). On the trip demo, which links no plugins, the
// person adds World clock and Clock from the registry. Turning on World clock
// turns on Clock, which provides the clock service it needs, and the clocks
// draw; turning Clock off turns World clock off with it. Every service a
// registry package needs is one the registry or the site's kernel modules
// provide, and the app maker's checks count a service the app's own plugin
// provides as there.
import { readFileSync } from "node:fs";
import { expected } from "../../scripts/packages.mjs";

export default async function ({ check, openTab, URL }) {
  const { packages } = JSON.parse(readFileSync(new globalThis.URL("../../packages/index.json", import.meta.url), "utf8"));
  const listing = readFileSync(new globalThis.URL("../../packages/index.html", import.meta.url), "utf8");
  check("the registry's page at /packages/ lists every package in the index (run npm run packages)", listing === (await expected())["index.html"] && packages.every((p) => listing.includes(`id="${p.id}"`)));

  const app = "demos/trip";
  const page = await openTab(`${URL}${app}/app.html`);
  const command = (name, arg) => page.evaluate(([name, arg]) => window.__host.command(name, arg), [name, { app, ...arg }]);
  const on = async () => Object.fromEntries((await command("user:list")).map((p) => [p.id, p.on]));
  try {
    // The services the site's kernel runs, as it describes itself (its core and the modules in kernel.json).
    const { data } = await page.evaluate(() => window.__host.command("reference"));
    const provided = new Set([...data.services.map((s) => s.name), ...packages.flatMap((p) => p.provides)]);
    const unmet = packages.flatMap((p) => p.services.filter((s) => !provided.has(s)).map((s) => `${p.id} needs ${s}`));
    check("every service a registry package needs is provided by a registry package or the site's kernel", !unmet.length, unmet.join(", "));

    for (const id of ["clock", "world-clock"]) await command("user:add", { url: `/packages/${id}/${id}.js` });
    const added = await on();
    check("registry plugins are added off", added.clock === false && added["world-clock"] === false, JSON.stringify(added));

    await command("user:on", { id: "world-clock" });
    const both = await on();
    check("turning on a person's plugin turns on their plugin that provides the service it needs", both.clock === true && both["world-clock"] === true, JSON.stringify(both));
    const time = await page
      .waitForFunction(() => /\d\d:\d\d/.test(document.querySelector(".world-clock strong")?.textContent ?? ""), null, { timeout: 10000 })
      .then(() => true, () => false);
    const refused = await page.evaluate(() => window.__host.traces.filter((e) => e.name === "plugin:refused" && /World clock/.test(e.detail ?? "")).map((e) => e.detail));
    check("World clock draws on an app that links nothing, with no change to kernel.json", time && !refused.length, refused.join("; "));

    await command("user:off", { id: "clock" });
    const off = await on();
    check("turning off the plugin that provides a service turns off the person's plugins that need it", off.clock === false && off["world-clock"] === false, JSON.stringify(off));

    // A standard plugin from the registry draws on a page with no slot for it, through its manifest's place.
    await command("user:add", { url: "/std/undo.js" });
    await command("user:on", { id: "undo" });
    const undo = await page
      .waitForFunction(() => !!document.querySelector('main [data-plugin="undo"] button'), null, { timeout: 10000 })
      .then(() => true, () => false);
    const why = undo ? "" : await page.evaluate(() => JSON.stringify(window.__host.places().filter((p) => p.plugin === "undo")));
    check("a standard plugin added from the registry draws on an app with no slot for it", undo, why);

    // The app maker's checks: a service the app's own plugin provides is there for its other plugins.
    const problems = await page.evaluate(async () => {
      const { checkFiles } = await import("/std/maker/checks.js");
      // Each plugin's manifest as an object, and its source written from it (the page's policy allows no eval to read it back).
      const tick = { id: "clocks-tick", name: "Tick", permissions: [], provides: { tick: { description: "The time.", methods: { now: { args: "()", returns: "string", description: "Now." } } } } };
      const face = { id: "clocks-face", name: "Face", permissions: ["tick"], services: ["tick"] };
      const sources = {
        tick: `export const manifest = ${JSON.stringify(tick, null, 2)};\nexport default (ctx) => ctx.provide("tick", { now: () => "" });`,
        face: `export const manifest = ${JSON.stringify(face, null, 2)};\nexport default async (ctx) => { await ctx.call("tick", "now"); };`,
      };
      const manifests = new Map([[sources.tick, tick], [sources.face, face]]);
      const manifestOf = (source) => manifests.get(source) ?? {};
      const files = new Map([
        ["app.html", '<!doctype html><html lang="en"><head><title>Clocks</title><link rel="plugin" href="tick.js"><link rel="plugin" href="face.js"></head><body><main></main></body></html>'],
        ["tick.js", sources.tick],
        ["face.js", sources.face],
      ]);
      const rules = {
        readManifest: (s) => ({ permissions: [], ...manifestOf(s) }),
        capabilities: (m) => new Set(m.permissions),
        grants: (caps, wanted) => caps.has(wanted),
        ELEMENTS: {}, COMPONENTS: {}, GLOBAL_ATTRIBUTES: [], ELEMENT_ATTRIBUTES: {}, DROPPED_WITH_CONTENT: new Set(),
        methods: new Map(), hooks: new Map(), services: new Set(),
        takenBy: () => undefined, collectionOwner: () => undefined,
      };
      return checkFiles(files, rules, "clocks").problems.filter((p) => /service/.test(p.message)).map((p) => `${p.file}: ${p.message}`);
    });
    check("the app maker's checks count a service the app's own plugin provides", !problems.length, problems.join("; "));
  } finally {
    for (const id of ["world-clock", "clock", "undo"]) await command("user:remove", { id }).catch(() => {});
    await page.close({ runBeforeUnload: true });
  }
}
