// The `debug` kernel module (docs/layers.md): tools for looking inside a
// running kernel, which no app needs to run. A site that leaves `debug` out of
// kernel.json has none of it built in.
//
// - The `debug` service: the trace, for developer tools such as
//   std/debug-console.js (`ctx.call("debug", "recent")`).
// - The page commands `bench` and `reload-test`, which the platform's tests run
//   (window.__host.command("bench", 500)): a hook round trip timed against one
//   answered in the kernel, and a plugin reloaded many times to show nothing is
//   left behind.
// - The page command `counts`: how many entries every list, map and set the
//   kernel keeps has now, each by where it is kept. tests/checks/hot-reload-leak.mjs
//   reads it before and after a plugin is reloaded a hundred times: a number
//   that grew is something a reload left behind, named.

import { declaredHooks, hookOwners, hooks } from "../../src/kernel/hooks";
import { record, recent, startedAt } from "../../src/kernel/trace";
import type { KernelModule, ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";

const debug = ({ apps }: ModuleKernel): ServiceProvider => {
  return {
    description: "The trace: everything the kernel, the pages and plugins did, and every error. For developer tools such as std/debug-console.js; hear new events with the `debug:trace` hook.",
    methods: {
      recent: {
        args: "()",
        returns: "{ startedAt, events: [{ seq, at, kind, name, plugin?, trace?, ms?, detail? }], tab?, app? }",
        needs: "debug:read",
        description: "The last 500 trace events, oldest first; `seq` counts up with each event, and `at` is milliseconds after `startedAt` (wall-clock ms). A tab-scoped caller also gets its `tab`, and `app`: the ids of the plugins the app open in that tab links, once it has opened one.",
      },
      app: {
        args: "()",
        returns: "{ tab?, app? }",
        needs: "debug:read",
        description: "For a tab-scoped caller: its `tab`, and the ids of the plugins the app open there links, or no `app` if the tab hasn't opened one yet. The trace's `app:open` event says when to ask again.",
      },
    },
    capability: () => "debug:read",
    call: (plugin, method) => {
      const tab = plugin.split("@")[1];
      const where = tab ? { tab, app: apps.linkedBy(tab) } : {};
      if (method === "app") return where;
      if (method === "recent") return { startedAt, events: recent(), ...where };
      throw new Error(`debug.${method} is not a method`);
    },
  };
};

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 1000) / 1000;
};

/** Round trip of a serial hook answered by a plugin in another worker, against one answered in the kernel. */
async function bench({ root }: ModuleKernel, n: number) {
  const remoteTimes: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await root.serial({ trace: `bench-${i}` }, "bench:ping", i);
    remoteTimes.push(performance.now() - t);
  }
  const fiber = root.plugin({ name: "bench-local", apply: (ctx: any) => {
      ctx.on("bench:local", async (i: number) => i);
    },
  });
  await fiber;
  const localTimes: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await root.serial("bench:local", i);
    localTimes.push(performance.now() - t);
  }
  await fiber.dispose();
  const result = {
    n,
    remote: { p50: percentile(remoteTimes, 50), p95: percentile(remoteTimes, 95), max: percentile(remoteTimes, 100) },
    local: { p50: percentile(localTimes, 50), p95: percentile(localTimes, 95) },
  };
  record({ kind: "note", name: "bench", detail: JSON.stringify(result) });
  return result;
}

const hookCount = (root: any) =>
  Object.entries(root.events._hooks as Record<string, unknown[]>)
    .filter(([name]) => !name.startsWith("internal/"))
    .reduce((n, [, list]) => n + list.length, 0);

/** Reloads a sandboxed plugin many times and checks nothing is left behind. */
async function reloadTest({ root, hosts, remote }: ModuleKernel, n: number) {
  const before = { hooks: hookCount(root), workers: await hosts.bridge("host", "workerCount", []) };
  let failures = 0;
  for (let i = 0; i < n; i++) if (!(await remote.reload("word-count"))) failures++;
  // Let terminate messages reach the tab.
  await new Promise((r) => setTimeout(r, 200));
  const after = { hooks: hookCount(root), workers: await hosts.bridge("host", "workerCount", []) };
  const result = { n, failures, before, after };
  record({ kind: "note", name: "reload-test", detail: JSON.stringify(result) });
  return result;
}

/**
 * How many entries each collection the kernel keeps has, by where it is kept: `remote.live`, `hosts.views`,
 * `cordis.hooks.data:changed`. Everything reachable from the kernel's parts is walked, a few levels down, so a
 * list added later is counted without being named here. A collection's own entries are walked only while it is
 * small: a big one is counted, not read.
 */
function counts(kernel: ModuleKernel): Record<string, number> {
  const { root, hosts, remote, collections, reviews, userAdded, moved } = kernel;
  const out: Record<string, number> = {};
  const seen = new WeakSet<object>();
  const walk = (value: unknown, path: string, depth: number) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 5) return;
    seen.add(value);
    const proto = Object.getPrototypeOf(value);
    const plain = proto === Object.prototype || proto === null;
    if (value instanceof Map || value instanceof Set || Array.isArray(value)) {
      const size = Array.isArray(value) ? value.length : value.size;
      out[path] = size;
      if (size > 40) return;
      let i = 0;
      for (const entry of value instanceof Map ? value : [...value].map((v) => [i++, v] as const)) walk(entry[1], `${path}.${typeof entry[0] === "string" ? entry[0] : "*"}`, depth + 1);
      return;
    }
    // Not Cordis's own objects (its listeners and plugins are counted below), and nothing of the browser's: a port, a file handle.
    if (value === root || "registry" in value || "scope" in value || (typeof EventTarget !== "undefined" && value instanceof EventTarget) || ArrayBuffer.isView(value) || /Handle\]$/.test(String(value))) return;
    if (plain) out[`${path}{}`] = Object.keys(value).length;
    for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`, depth + 1);
  };
  walk(remote, "remote", 0);
  walk(hosts, "hosts", 0);
  walk(collections, "collections", 0);
  walk(reviews, "reviews", 0);
  walk(userAdded, "userAdded", 0);
  walk(moved, "moved", 0);
  walk(hooks, "hooks", 0);
  walk(hookOwners, "hookOwners", 0);
  walk(declaredHooks, "declaredHooks", 0);
  // Cordis: every listener by its hook, and every plugin it runs.
  out["cordis.listeners"] = hookCount(root);
  for (const [name, list] of Object.entries(root.events._hooks as Record<string, unknown[]>)) if (!name.startsWith("internal/")) out[`cordis.hooks.${name}`] = list.length;
  const registry = (root.registry as { size?: number } | undefined)?.size;
  if (typeof registry === "number") out["cordis.plugins"] = registry;
  return out;
}

export default {
  name: "debug",
  apply(_ctx, kernel) {
    kernel.hook("bench:ping", { mode: "serial", timeoutMs: 1000, onFailure: "open", args: "n", description: "Used by the round-trip benchmark; answer with anything." });
    kernel.provide("debug", debug(kernel));
    kernel.command("bench", (arg) => bench(kernel, Number(arg) || 300));
    kernel.command("reload-test", (arg) => reloadTest(kernel, Number(arg) || 50));
    kernel.command("counts", () => counts(kernel));
  },
} satisfies KernelModule;
