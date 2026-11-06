// End-to-end checks for the phase 0 spike. Builds are served with
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
  await a.waitForFunction(() => window.__host.traces.filter((e) => e.name === "plugin:ready").length >= 7, null, { timeout: 10000 });
  check("all seven sandboxed plugins start in their own workers", (await a.evaluate(() => window.__host.workers.size)) === 7);
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
  await a.click("text=Play 440 Hz");
  await a.waitForFunction(() => window.__host.audioStats.played > 0, null, { timeout: 5000 });
  check("tone.js plays through an AudioWorklet", true, `context ${await a.evaluate(() => window.__host.audioStats.state)}`);

  // Drawing: an OffscreenCanvas animated in the plugin's worker.
  await a.waitForFunction(() => window.__host.traces.some((e) => e.plugin === "bars" && /frames drawn: [1-9]/.test(e.detail ?? "")), null, { timeout: 5000 });
  const frames = await a.evaluate(() => window.__host.traces.filter((e) => e.plugin === "bars" && e.detail?.startsWith("frames")).at(-1).detail);
  check("bars.js draws on an OffscreenCanvas in its worker", true, frames);

  // Observability: one action followed across threads by its trace id.
  const traced = await a.evaluate(() => {
    const byTrace = new Map();
    for (const e of window.__host.traces) if (e.trace) byTrace.set(e.trace, [...(byTrace.get(e.trace) ?? []), e]);
    return [...byTrace.values()].some((events) => events.some((e) => e.kind === "dispatch") && events.some((e) => e.kind === "remote"));
  });
  check("a trace id links a dispatch in the kernel to the plugin answering it", traced);

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
  check("only the first tab runs plugin workers", (await b.evaluate(() => window.__host.workers.size)) === 0 && !(await b.evaluate(() => window.__host.spawner)));
  check("plugin views appear in the second tab", (await b.textContent("aside")).includes("Tone"));

  // Hand over: close the spawner tab; the second tab starts the plugins again.
  await a.close({ runBeforeUnload: true });
  await b.waitForFunction(() => window.__host.spawner && window.__host.workers.size === 7, null, { timeout: 10000 });
  check("closing the spawner tab moves the plugin workers to the other tab", true);
  await b.click("nav >> text=Hello there");
  await b.waitForFunction(() => /\d+ words/.test(document.querySelector("footer").textContent), null, { timeout: 5000 });
  check("plugins work again after the handover", true, await status(b));

  // ---- Fallback: kernel in a dedicated worker ----
  const isolated = await browser.newContext();
  const c = await isolated.newPage();
  c.on("pageerror", (e) => errors.push(e.message));
  await c.goto(`${URL}?kernel=dedicated`);
  await c.waitForFunction(() => window.__host && window.__host.workers.size === 7, null, { timeout: 10000 });
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
