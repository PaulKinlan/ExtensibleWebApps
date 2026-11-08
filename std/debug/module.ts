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

export default {
  name: "debug",
  apply(_ctx, kernel) {
    kernel.hook("bench:ping", { mode: "serial", timeoutMs: 1000, onFailure: "open", args: "n", description: "Used by the round-trip benchmark; answer with anything." });
    kernel.provide("debug", debug(kernel));
    kernel.command("bench", (arg) => bench(kernel, Number(arg) || 300));
    kernel.command("reload-test", (arg) => reloadTest(kernel, Number(arg) || 50));
  },
} satisfies KernelModule;
