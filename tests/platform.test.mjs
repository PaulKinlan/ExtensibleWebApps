// End-to-end checks for the platform. Builds are served with
// `vite preview`; Chromium (Playwright) drives two tabs against one shared
// worker kernel, then a third with the dedicated-worker fallback.
//
//   npm test            build, run, print the measurements
//
// Exits non-zero if any check fails.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PORT = 4173;
const URL = `http://localhost:${PORT}/`;
const results = [];
const measurements = {};

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && resolve());
  server.on("exit", (code) => reject(new Error(`vite preview exited with ${code}`)));
  setTimeout(resolve, 5000);
});

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext();
const errors = [];

async function openTab(url = URL) {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__host);
  return page;
}

const traceHas = (page, fn) => page.evaluate(`window.__host.traces.some(${fn})`);
const status = (page) => page.textContent("footer");

try {
  // ---- One tab ----
  const a = await openTab();
  await a.waitForFunction(() => window.__host.traces.filter((e) => e.name === "plugin:ready").length >= 9, null, { timeout: 10000 });
  check("all nine sandboxed plugins start in their own workers", (await a.evaluate(() => window.__host.workers.size)) === 9);

  // Manifests are read before any code runs.
  const refused = await a.evaluate(() => window.__host.command("install", "export const manifest = { id: 'bad', name: 'Bad', permissions: ['ui'].concat(['network']) };\nexport default () => {};"));
  check("a manifest that isn't a plain literal is refused before running", refused.ok === false && /plain literal/.test(refused.error), refused.error);
  const decoy = await a.evaluate(() => window.__host.command("install", "// export const manifest = { id: 'decoy', name: 'Decoy', permissions: [] };\nconst x = 1;\nexport const manifest = Object.assign({}, { id: 'decoy', name: 'Decoy', permissions: [] });\nexport default () => {};"));
  check("a manifest in a comment can't stand in for the real one", decoy.ok === false && /must start with/.test(decoy.error), decoy.error);
  const suffix = await a.evaluate(() => window.__host.command("install", "export const manifest = { id: 'suffix', name: 'Suffix', permissions: [] }.valueOf();\nexport default () => {};"));
  check("anything after the manifest literal is refused", suffix.ok === false && /after the manifest/.test(suffix.error), suffix.error);
  const liar = await a.evaluate(() => window.__host.command("install", "export const manifest = { id: 'liar', name: 'Liar', permissions: [] };\nmanifest.permissions.push('audio');\nexport default () => {};"));
  await a.waitForFunction(() => window.__host.traces.some((e) => e.name === "plugin:manifest-changed" && e.plugin === "liar"), null, { timeout: 3000 }).catch(() => {});
  check("a plugin whose manifest changes when it runs is stopped", liar.ok && !liar.started && (await traceHas(a, `(e) => e.name === "plugin:manifest-changed" && e.plugin === "liar"`)), JSON.stringify(liar));
  // `late` also has a button whose handler makes a call before and after an await.
  const lateSource = `export const manifest = { id: 'late', name: 'Late', permissions: ['ui'], settings: { "mode:loud": { type: "boolean", title: "Loud" } } };
export default (ctx) => {
  ctx.ui.render('statusbar', 'late', { type: 'stack', direction: 'row', children: [{ type: 'text', text: 'late plugin here' }, { type: 'button', label: 'Ping twice', action: 'ping' }] });
  ctx.ui.onEvent(async () => {
    const here = ctx.traced();
    await here.call('kernel', 'ping');
    await here.call('kernel', 'ping');
  });
};`;
  const installed = await a.evaluate((source) => window.__host.command("install", source), lateSource);
  await a.waitForSelector("footer >> text=late plugin here");
  check("a plugin installed at run time starts and renders", installed.ok && installed.started);
  const reserved = await a.evaluate(() => window.__host.command("install", "export const manifest = { id: 'plugins', name: 'Fake panel', permissions: ['ui'] };\nexport default () => {};"));
  check("a plugin can't take an id the kernel uses for its own views", reserved.ok === false && /reserved/.test(reserved.error), reserved.error);

  // The plugins panel: where each plugin came from, on and off, remove.
  const panel = (id) => `aside [data-key="plugins:${id}"]`;
  await a.waitForSelector(`${panel("late")} >> text=with the data`);
  check("the plugins panel shows built-in plugins and ones kept with the data", (await a.textContent(panel("tone"))).includes("built in"));
  const workers = () => a.evaluate(() => window.__host.workers.size);
  const before = await workers();
  await a.click(`${panel("sneaky")} >> text=Turn off`);
  await a.waitForFunction((n) => window.__host.workers.size === n - 1, before, { timeout: 5000 });
  await a.click(`${panel("sneaky")} >> text=Turn on`);
  await a.waitForFunction((n) => window.__host.workers.size === n, before, { timeout: 5000 });
  check("turning a plugin off stops its worker, and on starts it again", true, `${before} → ${before - 1} → ${before} workers`);
  await a.evaluate(() => window.__host.command("install", "export const manifest = { id: 'temp', name: 'Temporary', permissions: [] };\nexport default () => {};"));
  await a.waitForFunction((n) => window.__host.workers.size === n + 1, before, { timeout: 5000 });
  await a.click(`${panel("temp")} >> text=Remove`);
  await a.waitForFunction((n) => window.__host.workers.size === n, before, { timeout: 5000 });
  check("removing a plugin kept with the data stops it and takes it off the panel", !(await a.$(panel("temp"))));
  check("built-in plugins can't be removed", !(await a.$(`${panel("tone")} >> text=Remove`)));

  // Worker content security policy.
  await a.waitForFunction(() => window.__host.traces.filter((e) => e.detail?.startsWith("network:")).length >= 2, null, { timeout: 5000 });
  const net = await a.evaluate(() => Object.fromEntries(window.__host.traces.filter((e) => e.detail?.startsWith("network:")).map((e) => [e.plugin, e.detail])));
  check("a plugin with the network permission can fetch", /status 200/.test(net.fetcher ?? ""), net.fetcher);
  check("a plugin without it is blocked by its worker's CSP", /refused/.test(net.offline ?? ""), net.offline);
  // offline also tries to start a network-enabled worker of its own.
  await a.waitForFunction(() => window.__host.traces.some((e) => e.plugin === "offline" && e.detail?.startsWith("escape:")), null, { timeout: 5000 }).catch(() => {});
  const escape = await a.evaluate(() => window.__host.traces.filter((e) => e.plugin === "offline" && e.detail?.startsWith("escape:")).map((e) => e.detail).join(", "));
  check("a plugin can't start a worker of its own", /blocked/.test(escape), escape);
  check("the kernel runs in a shared worker", (await a.textContent("#mode")).includes("shared worker"));

  // Editor extensions, unchanged, through the shim.
  await a.click("nav >> text=Welcome");
  await a.waitForFunction(() => document.querySelector("footer").textContent.includes("words"));
  check("editor's word-count.js runs unchanged and fills the status bar", /\d+ words · \d+ min read/.test(await status(a)), await status(a));

  await a.fill("textarea", "Hello there\n\nOne two three four five six seven eight nine ten.");
  await a.waitForFunction(() => document.querySelector("footer").textContent.includes("12 words"));
  check("edits reach plugin workers after the debounce", (await status(a)).includes("12 words"));
  check("editor's edit-times.js runs unchanged", (await status(a)).includes("Edited just now"), await status(a));

  await a.click("text=Save");
  await a.waitForSelector("main >> text=Saved");
  check("a save passes the intercepting plugin", true);

  // Interception: a plugin in a worker blocks a write through a serial hook.
  await a.fill("textarea", "THIS IS ALL CAPITALS AND SHOULD NOT SAVE");
  await a.waitForTimeout(400);
  await a.click("text=Save");
  await a.waitForSelector("text=Not saved: the note is all capitals");
  check("no-shouting.js blocks the write from its worker", true);

  // The gate.
  check("the gate refuses a hook the manifest doesn't grant", await traceHas(a, `(e) => e.kind === "denied" && e.plugin === "sneaky" && e.name === "hook:intercept:data:beforeWrite"`));
  check("the gate refuses a service the manifest doesn't grant", await traceHas(a, `(e) => e.kind === "denied" && e.plugin === "sneaky" && e.name === "audio"`));

  // Audio: DSP in an AudioWorklet, registered by a plugin in a worker.
  // Settings: a form built from the manifest; the plugin hears the change.
  await a.fill(`${panel("tone")} input[name=frequency]`, "880");
  await a.press(`${panel("tone")} input[name=frequency]`, "Tab");
  await a.waitForSelector("text=Play 880 Hz", { timeout: 5000 });
  check("a settings form built from the manifest reaches the plugin", true);
  await a.selectOption(`${panel("tone")} select[name=wave]`, "square");
  await a.waitForFunction(() => window.__host.traces.some((e) => e.name === "settings:changed" && e.detail === 'wave = "square"'));
  check("a select field takes its options from the manifest's enum", (await a.$$eval(`${panel("tone")} select[name=wave] option`, (o) => o.map((x) => x.value))).join() === "sine,square");
  check("focus stays on the field after the panel redraws", await a.evaluate(() => document.activeElement?.getAttribute("name") === "wave"));
  await a.check(`${panel("late")} input[name="mode:loud"]`);
  await a.waitForFunction(() => window.__host.traces.some((e) => e.plugin === "late" && e.name === "settings:changed" && e.detail === "mode:loud = true"), null, { timeout: 5000 }).catch(() => {});
  const colon = await a.evaluate(() => window.__host.traces.filter((e) => e.plugin === "late" && e.name.startsWith("settings:")).map((e) => `${e.name} ${e.detail}`).join("; "));
  check("a setting whose key has a colon saves", /settings:changed mode:loud = true/.test(colon), colon);

  await a.click("text=Play 880 Hz");
  await a.waitForFunction(() => window.__host.audioStats.played > 0, null, { timeout: 5000 });
  check("tone.js plays through an AudioWorklet", true, `context ${await a.evaluate(() => window.__host.audioStats.state)}`);
  await a.waitForFunction(() => window.__host.traces.some((e) => e.plugin === "tone" && e.detail === "played 1"), null, { timeout: 5000 });
  const played = await a.evaluate(() => {
    const log = window.__host.traces.find((e) => e.plugin === "tone" && e.detail === "played 1");
    return { trace: log.trace, with: window.__host.traces.filter((e) => log.trace && e.trace === log.trace).map((e) => `${e.kind}:${e.name}`) };
  });
  check("a plugin's log after an await keeps the trace of the click it handles", Boolean(played.trace) && played.with.some((x) => x.startsWith("bridge:")), `#${played.trace}: ${played.with.join(", ")}`);
  await a.click("text=Ping twice");
  await a.waitForFunction(() => window.__host.traces.filter((e) => e.plugin === "late" && e.name === "kernel.ping").length >= 2, null, { timeout: 5000 });
  const pings = await a.evaluate(() => window.__host.traces.filter((e) => e.plugin === "late" && e.name === "kernel.ping").map((e) => e.trace));
  check("a plugin's service call after an await keeps the trace of the click it handles", pings.length === 2 && Boolean(pings[0]) && pings[0] === pings[1], pings.join(", "));

  // Drawing: an OffscreenCanvas animated in the plugin's worker.
  await a.waitForFunction(() => window.__host.traces.some((e) => e.plugin?.startsWith("bars@") && /frames drawn: [1-9]/.test(e.detail ?? "")), null, { timeout: 5000 });
  const frames = await a.evaluate(() => window.__host.traces.filter((e) => e.plugin?.startsWith("bars@") && e.detail?.startsWith("frames")).at(-1).detail);
  check("bars.js (scope: tab) draws on an OffscreenCanvas in its worker", true, frames);

  // Observability: one save followed across awaits and workers by its trace id.
  const saveTrace = await a.evaluate(() => {
    const blocked = window.__host.traces.find((e) => e.kind === "remote" && e.plugin === "no-shouting" && e.detail?.includes("all capitals"));
    return blocked ? window.__host.traces.filter((e) => e.trace === blocked.trace).map((e) => `${e.kind}:${e.name}`) : [];
  });
  check("a trace id links the click, the kernel dispatch and the plugin's answer", saveTrace.includes("dispatch:data:beforeWrite") && saveTrace.includes("remote:data:beforeWrite"), saveTrace.join(", "));
  await a.fill("textarea", "Hello there\n\nOne two three four five six seven eight nine ten.");
  await a.waitForTimeout(400);
  await a.click("text=Save");
  await a.waitForSelector("main >> text=Saved");
  await a.waitForTimeout(300);
  const afterAwait = await a.evaluate(() => {
    const changed = window.__host.traces.filter((e) => e.kind === "dispatch" && e.name === "data:changed" && e.trace).at(-1);
    return changed ? window.__host.traces.filter((e) => e.trace === changed.trace).map((e) => `${e.kind}:${e.name}`) : [];
  });
  check("the trace id survives the awaits between a write's check and its change event", afterAwait.includes("dispatch:data:beforeWrite") && afterAwait.includes("dispatch:data:changed") && afterAwait.includes("dispatch:note:save"), afterAwait.join(", "));

  // Measurements.
  const bench = await a.evaluate(() => window.__host.command("bench", 500));
  measurements.hookRoundTrip = bench;
  check("hook round trip to a plugin worker: p95 under 2 ms", bench.remote.p95 < 2, `p50 ${bench.remote.p50} ms, p95 ${bench.remote.p95} ms, in-kernel p50 ${bench.local.p50} ms`);

  const reload = await a.evaluate(() => window.__host.command("reload-test", 100));
  measurements.reload = reload;
  check(
    "100 reloads leave no listeners or workers behind",
    reload.failures === 0 && reload.before.hooks === reload.after.hooks && reload.before.workers === reload.after.workers,
    `listeners ${reload.before.hooks} → ${reload.after.hooks}, workers ${reload.before.workers} → ${reload.after.workers}, ${reload.failures} failed`,
  );

  // ---- Two tabs, one kernel ----
  const b = await openTab();
  await b.waitForSelector("nav >> text=Hello there");
  check("a second tab shares the kernel and sees the same notes", true);
  await b.waitForFunction(() => window.__host.workers.size === 1, null, { timeout: 5000 });
  check("the second tab runs only its own tab-scoped plugin", [...(await b.evaluate(() => [...window.__host.workers.keys()]))].every((k) => k.startsWith("bars@")) && !(await b.evaluate(() => window.__host.spawner)));
  await b.waitForFunction((t) => window.__host.traces.some((e) => e.plugin === `bars@${t}` && /frames drawn: [1-9]/.test(e.detail ?? "")), await b.evaluate(() => window.__host.tab), { timeout: 5000 });
  check("a tab-scoped plugin draws in the second tab too", true);
  check("plugin views appear in the second tab", (await b.textContent("aside")).includes("Tone"));

  // Hand over: close the spawner tab; the second tab starts the plugins again.
  await a.close({ runBeforeUnload: true });
  await b.waitForFunction(() => window.__host.spawner && window.__host.workers.size === 10, null, { timeout: 10000 });
  check("closing the spawner tab moves the plugin workers to the other tab", true);
  await b.click("nav >> text=Hello there");
  await b.waitForFunction(() => /\d+ words/.test(document.querySelector("footer").textContent), null, { timeout: 5000 });
  check("plugins work again after the handover", true, await status(b));

  // A second kernel on the same data folder loads what the first one kept there.
  const d = await openTab(`${URL}?kernel=dedicated`);
  await d.waitForSelector("footer >> text=late plugin here", { timeout: 10000 });
  await d.waitForSelector("text=Play 880 Hz", { timeout: 5000 });
  const dPlugins = await d.$$eval('aside [data-key^="plugins:"]', (els) => els.map((e) => e.dataset.key.slice(8)));
  check(
    "installed plugins and settings are kept with the data and load in a new kernel",
    dPlugins.includes("late") && !dPlugins.includes("temp") && !dPlugins.includes("liar"),
    dPlugins.join(", "),
  );
  await d.close();

  // ---- Fallback: kernel in a dedicated worker ----
  const isolated = await browser.newContext();
  const c = await isolated.newPage();
  c.on("pageerror", (e) => errors.push(e.message));
  await c.goto(`${URL}?kernel=dedicated`);
  await c.waitForFunction(() => window.__host && window.__host.workers.size === 9, null, { timeout: 10000 });
  check("the kernel also runs in a dedicated worker", (await c.textContent("#mode")).includes("dedicated worker"));
  await isolated.close();

  check("no uncaught errors in any page", errors.length === 0, errors.join("; "));
} catch (error) {
  check("the run finished", false, String(error));
} finally {
  await browser.close();
  server.kill();
}

console.log("\nMeasurements:", JSON.stringify(measurements, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
