// Worker flood protection and liveness tracking (src/kernel/remote.ts), plus
// the on-demand boundary for the agent file reader (src/kernel/agents/file.ts):
// runaway plugins sending >500 calls or renders a second have excess messages
// refused with `plugin:rate-limit` without stalling the kernel, `ping` traces
// `plugin:unresponsive` when a worker stops answering, and no kernel or `std/`
// module statically pulls `agents/file.ts` into the main chunk.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "cordis";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function tsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return /\.[jt]s$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

export default async function ({ a, check }) {
  // 1. On-demand layer check: neither src/kernel/ nor std/ statically imports src/kernel/agents/file.ts.
  const target = resolve(ROOT, "src/kernel/agents/file.ts");
  const staticImport = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;
  const offenders = [...tsFiles(resolve(ROOT, "src/kernel")), ...tsFiles(resolve(ROOT, "std"))].filter((file) => {
    if (file === target) return false;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(staticImport)) {
      const resolved = resolve(dirname(file), match[1]).replace(/\.[jt]s$/, "");
      if (resolved === target.replace(/\.ts$/, "")) return true;
    }
    return false;
  });
  check(
    "neither src/kernel/ nor std/ statically imports src/kernel/agents/file.ts, keeping it an on-demand chunk",
    offenders.length === 0,
    offenders.map((f) => f.slice(ROOT.length + 1)).join(", "),
  );

  // 2. Unit-level liveness check on RemotePlugins.ping() over MessageChannel ports.
  const inlined = await build({
    stdin: {
      contents: 'export { RATE_LIMIT, RemotePlugins } from "./src/kernel/remote.ts";\nexport { recent } from "./src/kernel/trace.ts";',
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const { RATE_LIMIT, RemotePlugins, recent } = await import(`data:text/javascript;base64,${Buffer.from(inlined.outputFiles[0].text).toString("base64")}`);

  const root = new Context();
  const host = { tab: "t1" };
  const spawned = new Map();
  const hosts = {
    mode: "shared",
    spawner: host,
    workerHosts: [host],
    list: [host],
    send(_to, msg) {
      if (msg.t === "spawn") {
        const ch = new MessageChannel();
        spawned.set(msg.plugin, ch.port2);
        const mode = msg.plugin;
        ch.port2.onmessage = (ev) => {
          if (mode === "responsive" && ev.data?.t === "hook" && ev.data.id !== undefined) {
            ch.port2.postMessage({ t: "hook:result", id: ev.data.id, ok: true });
          }
        };
        ch.port2.start();
        remote.attach(msg.plugin, host, ch.port1);
        ch.port2.postMessage({ t: "ready", manifest: { id: msg.plugin, name: msg.plugin, permissions: [] } });
      }
      if (msg.t === "terminate") spawned.get(msg.plugin)?.close();
    },
    clear() {},
    render() {},
  };
  const remote = new RemotePlugins(root, hosts, {});
  try {
    await remote.install("export const manifest = { id: 'responsive', name: 'responsive', permissions: [] };\nexport default () => {};", { origin: "app" });
    await remote.install("export const manifest = { id: 'hung', name: 'hung', permissions: [] };\nexport default () => {};", { origin: "app" });

    const alive = await remote.ping("responsive", 200);
    const hungBefore = recent().filter((e) => e.name === "plugin:unresponsive").length;
    check("RemotePlugins.ping resolves true for a responsive worker without tracing plugin:unresponsive", alive === true && hungBefore === 0, `alive=${alive}, unresponsive=${hungBefore}`);

    const dead = await remote.ping("hung", 60);
    const hungEvents = recent().filter((e) => e.name === "plugin:unresponsive" && e.plugin === "hung");
    check(
      "RemotePlugins.ping resolves false and traces plugin:unresponsive when a worker fails to answer in time",
      dead === false && hungEvents.length === 1 && hungEvents[0].kind === "error",
      JSON.stringify(hungEvents),
    );

    const missing = await remote.ping("does-not-exist", 50);
    const inFlight = remote.ping("hung", 500);
    remote.stop("hung");
    const stoppedResult = await inFlight;
    const afterStop = recent().filter((e) => e.name === "plugin:unresponsive" && e.plugin === "hung").length;
    check(
      "pinging a stopped or missing instance resolves false without a spurious plugin:unresponsive trace",
      missing === false && stoppedResult === false && afterStop === 1,
      `missing=${missing}, stopped=${stoppedResult}, traces=${afterStop}`,
    );
  } finally {
    remote.uninstall("responsive");
    remote.uninstall("hung");
    for (const p of spawned.values()) p.close();
  }

  // 3. End-to-end flood protection in the running browser kernel.
  const install = (src) => a.evaluate((source) => window.__host.command("install", source), src);
  const uninstall = (id) => a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
  const waitLog = async (id, prefix) => {
    for (let end = Date.now() + 8000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
      const hit = await a.evaluate(([i, p]) => window.__host.traces.some((e) => e.plugin === i && e.detail?.startsWith(p)), [id, prefix]);
      if (hit) return true;
    }
    return false;
  };
  const logs = (id, prefix) => a.evaluate(([i, p]) => window.__host.traces.filter((e) => e.plugin === i && e.detail?.startsWith(p)).map((e) => e.detail), [id, prefix]);

  try {
    await install(`export const manifest = { id: 'flood-calls', name: 'Flood calls', permissions: [] };
export default async (ctx) => {
  const burst = await Promise.allSettled(Array.from({ length: ${RATE_LIMIT + 120} }, () => ctx.call('kernel', 'ping')));
  const ok = burst.filter((r) => r.status === 'fulfilled').length;
  const rejected = burst.filter((r) => r.status === 'rejected' && /rate limit/i.test(String(r.reason?.message ?? r.reason))).length;
  await new Promise((r) => setTimeout(r, 1050));
  const recovered = await ctx.call('kernel', 'ping').then((v) => v === 'pong', () => false);
  ctx.log('summary ' + JSON.stringify({ ok, rejected, recovered }));
};`);
    const callDone = await waitLog("flood-calls", "summary ");
    const callSummary = JSON.parse(((await logs("flood-calls", "summary "))[0] ?? "summary {}").slice(8));
    const callRateEvents = await a.evaluate(() => window.__host.traces.filter((e) => e.name === "plugin:rate-limit" && e.plugin === "flood-calls"));
    check(
      "call flood (>500/s) rejects excess calls cleanly, traces plugin:rate-limit once per window, and recovers in the next second",
      callDone && callSummary.ok === RATE_LIMIT && callSummary.rejected === 120 && callSummary.recovered === true && callRateEvents.length === 1 && callRateEvents[0].kind === "denied",
      JSON.stringify({ callSummary, callRateEvents }),
    );

    await install(`export const manifest = { id: 'flood-renders', name: 'Flood renders', permissions: ['ui'] };
export default async (ctx) => {
  for (let i = 0; i < ${RATE_LIMIT + 150}; i++) ctx.ui.render('status', 'flood', 'frame ' + i);
  await new Promise((r) => setTimeout(r, 1050));
  ctx.ui.render('status', 'flood', 'calm frame');
  const pong = await ctx.call('kernel', 'ping');
  ctx.log('rendered ' + pong);
};`);
    const renderDone = await waitLog("flood-renders", "rendered ");
    const renderRateEvents = await a.evaluate(() => window.__host.traces.filter((e) => e.name === "plugin:rate-limit" && e.plugin === "flood-renders"));
    const shown = await a.locator('footer [data-key="flood-renders:flood"]').textContent().catch(() => "");
    check(
      "render flood (>500/s) drops excess renders cleanly without stalling the kernel and draws again in the next window",
      renderDone && renderRateEvents.length === 1 && /calm frame/.test(shown ?? ""),
      JSON.stringify({ renderDone, renderRateEvents, shown }),
    );
  } finally {
    await uninstall("flood-calls");
    await uninstall("flood-renders");
  }
}
