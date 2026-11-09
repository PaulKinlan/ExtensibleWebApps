// The app maker for real (batch 3 of the gap doc):
//
//   one set of checks   `npm run check` and the app maker's checks are one
//                       module (std/maker/checks.js), and both count a
//                       service a registry package provides: an app that
//                       links /packages/clock/clock.js may call clock
//   folders             a made app is saved to a folder the person picks,
//                       and an app is made from one, after a review
//   plugin editor       offered in the registry, its starting templates
//                       copied with it from the folder beside it
//   one provider        turning on a second provider of a service turns the
//                       first one off, and the swap is never refused
//
// The folder picker is the page's showDirectoryPicker, which a test can't
// click through, so it is replaced by one that hands back folders in the
// browser's private file system.
import { checkApps } from "../../scripts/check.mjs";

export default async function ({ check, context, URL, errors }) {
  // ---- One set of checks, on disk and in the browser ----
  const [onDisk] = await checkApps(["tests/fixtures/registry-app"]);
  check("npm run check counts the service a registry package provides", !onDisk.problems.length && onDisk.plugins.includes("clock"), onDisk.problems.map((p) => p.message).join("; "));

  const own = await context.browser().newContext();
  // Folders the picker hands out, in order: picked-1, picked-2, …, in the private file system.
  await own.addInitScript(() => {
    let n = 0;
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(`picked-${++n}`, { create: true });
  });
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`${URL}demos/trip/app.html`);
    await page.waitForFunction(() => window.__host);
    const made = await page.evaluate(async () => {
      const { checkFiles, siteFiles } = await import("/std/maker/checks.js");
      const face = { id: "clocks-face", name: "Face", permissions: ["ui", "clock"], services: ["clock"] };
      const faceSource = `export const manifest = ${JSON.stringify(face)};\nexport default async (ctx) => { await ctx.call("clock", "now"); };`;
      const page = (links) => `<!doctype html><html lang="en"><head><title>Clocks</title><script type="module" src="/platform/host.js"></script>${links}<link rel="plugin" href="face.js"></head><body><main></main></body></html>`;
      // The page's policy allows no eval, so manifests are read from a table rather than the source.
      const clock = { id: "clock", name: "Clock", permissions: ["provide:clock"], provides: { clock: { methods: { now: {} } } } };
      const rules = {
        readManifest: (s) => {
          if (s === faceSource) return { permissions: [], ...face };
          if (/id: "clock"/.test(s)) return clock;
          throw new Error("The module must start with `export const manifest = { ... }`");
        },
        capabilities: (m) => new Set(m.permissions),
        grants: (caps, wanted) => caps.has(wanted),
        ELEMENTS: {}, COMPONENTS: {}, GLOBAL_ATTRIBUTES: [], ELEMENT_ATTRIBUTES: {}, DROPPED_WITH_CONTENT: new Set(),
        methods: new Map(), hooks: new Map(), services: new Set(),
      };
      const run = async (links) => {
        const files = new Map([["app.html", page(links)], ["face.js", faceSource]]);
        const site = new Map();
        const wanted = siteFiles(files, "clocks");
        for (const path of wanted) {
          const response = await fetch(path);
          if (response.ok) site.set(path, await response.text());
        }
        return { wanted, problems: checkFiles(files, rules, "clocks", site).problems.filter((p) => p.level === "error").map((p) => `${p.file}: ${p.message}`) };
      };
      return {
        linked: await run('<link rel="plugin" href="/packages/clock/clock.js">'),
        unlinked: await run(""),
        missing: await run('<link rel="plugin" href="/packages/nope/nope.js">'),
      };
    });
    check("the app maker reads the registry packages a made app links, and counts the services they provide", made.linked.wanted.includes("/packages/clock/clock.js") && !made.linked.problems.length, JSON.stringify(made.linked));
    check("…and without the package, a call to its service is flagged", made.unlinked.problems.some((p) => /no clock service/.test(p)), made.unlinked.problems.join("; "));
    check("…and a link to a package the site doesn't have is flagged", made.missing.problems.some((p) => /nope\.js (doesn't exist|isn't a plugin) on this site/.test(p)), made.missing.problems.join("; "));

    // ---- One provider of a service at a time ----
    const app = "demos/trip";
    const command = (name, arg) => page.evaluate(([name, arg]) => window.__host.command(name, arg), [name, { app, ...arg }]);
    const on = async () => Object.fromEntries((await command("user:list")).map((p) => [p.id, p.on]));
    for (const id of ["clock", "world-clock"]) await command("user:add", { url: `/packages/${id}/${id}.js` });
    await command("user:on", { id: "world-clock" });
    const clockB = `export const manifest = {
  id: "clock-b",
  name: "Clock B",
  version: "1.0.0",
  permissions: ["provide:clock"],
  provides: { clock: { description: "Another clock.", methods: { now: { args: "()", description: "Now." } } } },
};
export default function (ctx) {
  ctx.provide("clock", { now: () => ({ time: "12:34", date: "Mon 1 Jan", timeZone: "UTC" }) });
}
`;
    await command("user:add", { files: [{ name: "clock-b.js", data: clockB }] });
    const since = await page.evaluate(() => window.__host.traces.at(-1)?.seq ?? 0);
    await command("user:on", { id: "clock-b" });
    const swapped = await on();
    // Clock B starts in Clock's place (World clock asks for the time every 30 s, so its next call goes to Clock B).
    const runs = await page.waitForFunction((since) => window.__host.traces.some((e) => e.seq > since && e.name === "plugin:ready" && e.plugin?.startsWith("clock-b")), since, { timeout: 10000 }).then(() => true, () => false);
    const refused = await page.evaluate((since) => window.__host.traces.filter((e) => e.seq > since && e.name === "plugin:refused").map((e) => e.detail), since);
    check("turning on a second provider of a service turns the first off, and it takes over without a refusal", swapped.clock === false && swapped["clock-b"] === true && swapped["world-clock"] === true && runs && !refused.length, `${JSON.stringify(swapped)} drew ${runs} ${refused.join("; ")}`);
    await command("user:off", { id: "clock-b" });
    const after = await on();
    check("…and turning that one off turns off what needs it", after["world-clock"] === false, JSON.stringify(after));
    for (const id of ["world-clock", "clock", "clock-b"]) await command("user:remove", { id }).catch(() => {});

    // ---- The plugin editor from the registry ----
    const registry = await page.evaluate(() => fetch("/packages/index.json").then((r) => r.json()));
    check("the registry offers the plugin editor", registry.packages.some((p) => p.id === "plugin-editor" && p.href === "/std/plugin-editor.js"));
    await command("user:add", { url: "/std/plugin-editor.js" });
    await command("user:on", { id: "plugin-editor" });
    const editor = 'main [data-plugin="plugin-editor"]';
    const offered = await page.waitForSelector(`${editor} select option[value="template:card.js"]`, { state: "attached", timeout: 10000 }).then(() => true, () => false);
    if (offered) await page.selectOption(`${editor} select`, "template:card.js");
    const loaded = offered && (await page.waitForSelector(`${editor} >> text=My card asks to`, { timeout: 8000 }).then(() => true, () => false));
    check("the plugin editor added from the registry draws on an app with no slot for it, and loads a starting template copied with it", loaded, `offered ${offered}`);
    await command("user:remove", { id: "plugin-editor" }).catch(() => {});

    // ---- Made apps to and from a folder ----
    await page.goto(`${URL}new/`);
    await page.waitForFunction(() => window.__host);
    const yours = '[data-key^="your-apps@"][data-key$=":apps"]';
    const review = '[data-key^="review:"]';
    // The folder to open: picked-1 is the first the picker hands out.
    await page.evaluate(async () => {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("picked-1", { create: true });
      const write = async (name, text) => {
        const out = await (await folder.getFileHandle(name, { create: true })).createWritable();
        await out.write(text);
        await out.close();
      };
      await write("app.html", '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tide times</title><link rel="stylesheet" href="/platform/host.css"><script type="module" src="/platform/host.js"></script><link rel="plugin" href="tides.js"></head><body><main><slot name="main"></slot></main></body></html>');
      await write("tides.js", 'export const manifest = {\n  id: "tide-times",\n  name: "Tides",\n  version: "1.0.0",\n  permissions: ["ui"],\n};\n\nexport default function (ctx) {\n  ctx.ui.render("main", "tides", ctx.ui.html`<p>High water at noon</p>`);\n}\n');
      await write("notes.txt", "not part of the app");
    });
    await page.click(`${yours} button[data-action="open-folder"]`);
    const asked = await page.waitForSelector(`${review} >> text=makes Tide times`, { timeout: 15000 }).then(() => true, () => false);
    if (asked) await page.click(`${review} >> text="Accept"`);
    const opened = await page.waitForSelector(`${yours} button[data-action="pick"]:has-text("Tide times")`, { timeout: 10000 }).then(() => true, () => false);
    // The message is drawn once the save's checks are back, a moment after the app is listed: wait for it.
    const said = opened && (await page.waitForSelector(`${yours} >> text=Opened picked-1`, { timeout: 10000 }).then(() => true, () => false));
    check("an app is made from a folder the person picks, after one review, named after the folder", asked && opened && said, `asked ${asked}, listed ${opened}, said ${said}`);

    await page.click(`${yours} button[data-action="folder"]`);
    const saved = await page.waitForSelector(`${yours} >> text=Saved 2 files to the folder picked-2`, { timeout: 10000 }).then(() => true, () => false);
    const copy = await page.evaluate(async () => {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("picked-2");
      const out = {};
      for await (const [name, entry] of folder.entries()) out[name] = await (await entry.getFile()).text();
      return out;
    });
    check("a made app's files are saved to a folder the person picks", saved && /<title>Tide times<\/title>/.test(copy["app.html"] ?? "") && /High water at noon/.test(copy["tides.js"] ?? "") && Object.keys(copy).length === 2, Object.keys(copy).join(", "));
  } finally {
    await own.close();
  }
}
