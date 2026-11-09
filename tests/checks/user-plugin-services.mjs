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

export default async function ({ check, openTab, URL }) {
  const { packages } = JSON.parse(readFileSync(new globalThis.URL("../../packages/index.json", import.meta.url), "utf8"));
  const { modules } = JSON.parse(readFileSync(new globalThis.URL("../../kernel.json", import.meta.url), "utf8"));
  const provided = new Set([...modules, ...packages.flatMap((p) => p.provides)]);
  const unmet = packages.flatMap((p) => p.services.filter((s) => !provided.has(s)).map((s) => `${p.id} needs ${s}`));
  check("every service a registry package needs is provided by a registry package or one of the site's kernel modules", !unmet.length, unmet.join(", "));

  const app = "demos/trip";
  const page = await openTab(`${URL}${app}/app.html`);
  const command = (name, arg) => page.evaluate(([name, arg]) => window.__host.command(name, arg), [name, { app, ...arg }]);
  const on = async () => Object.fromEntries((await command("user:list")).map((p) => [p.id, p.on]));
  try {
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

    // The app maker's checks: a service the app's own plugin provides is there for its other plugins.
    const problems = await page.evaluate(async () => {
      const { checkFiles } = await import("/std/maker/checks.js");
      const manifestOf = (source) => new Function(`return ${/export const manifest = (\{[\s\S]*?\n\});/.exec(source)[1]}`)();
      const files = new Map([
        ["app.html", '<!doctype html><html lang="en"><head><title>Clocks</title><link rel="plugin" href="tick.js"><link rel="plugin" href="face.js"></head><body><main></main></body></html>'],
        ["tick.js", 'export const manifest = {\n  id: "clocks-tick", name: "Tick", permissions: [],\n  provides: { tick: { description: "The time.", methods: { now: { args: "()", returns: "string", description: "Now." } } } },\n};\nexport default (ctx) => ctx.provide("tick", { now: () => "" });'],
        ["face.js", 'export const manifest = {\n  id: "clocks-face", name: "Face", permissions: ["tick"], services: ["tick"],\n};\nexport default async (ctx) => { await ctx.call("tick", "now"); };'],
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
    for (const id of ["world-clock", "clock"]) await command("user:remove", { id }).catch(() => {});
    await page.close({ runBeforeUnload: true });
  }
}
