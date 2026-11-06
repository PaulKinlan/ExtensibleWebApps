// The kernel: Cordis core plus the bridge, the gate and the trace tap. It
// runs in a shared worker so every open tab talks to the same kernel, or in
// a dedicated worker where shared workers aren't available.
//
// Nothing in here draws UI or knows what a note is, except the two trusted
// demo plugins (store and notes) mounted at the bottom.

import { Context } from "cordis";
import { defineHook, hooks } from "./hooks";
import { Hosts } from "./hosts";
import { notesApp } from "./notes";
import { RemotePlugins, type ServiceProvider } from "./remote";
import { Store } from "./store";
import { record, recent, setSink, tap } from "./trace";

import wordCount from "../../plugins/word-count.js?raw";
import editTimes from "../../plugins/edit-times.js?raw";
import noShouting from "../../plugins/no-shouting.js?raw";
import tone from "../../plugins/tone.js?raw";
import bars from "../../plugins/bars.js?raw";
import pinger from "../../plugins/pinger.js?raw";
import sneaky from "../../plugins/sneaky.js?raw";
import fetcher from "../../plugins/fetcher.js?raw";
import offline from "../../plugins/offline.js?raw";

declare const SharedWorkerGlobalScope: { new (): unknown } | undefined;
const shared = typeof SharedWorkerGlobalScope !== "undefined" && self instanceof SharedWorkerGlobalScope;

const root: any = new Context();
tap(root);

// Hooks the kernel and its built-in plugins define. Plugins can define more.
defineHook("data:changed", { mode: "emit", description: "A record was written." });
defineHook("data:beforeWrite", { mode: "serial", timeoutMs: 1000, onFailure: "open", description: "Return { block } to stop a write." });
defineHook("note:open", { mode: "emit" });
defineHook("note:change", { mode: "emit" });
defineHook("note:save", { mode: "emit" });
defineHook("note:close", { mode: "emit" });
defineHook("bench:ping", { mode: "serial", timeoutMs: 1000, onFailure: "open" });

const hosts = new Hosts(shared ? "shared" : "dedicated");
setSink((events) => hosts.broadcast({ t: "trace", events }));

// Wire up connections first, so no tab's connect event is missed. Wiring: a shared worker gets a port per tab; a dedicated worker gets one port from its tab.
if (shared) {
  (self as any).onconnect = (e: MessageEvent) => hosts.connect(e.ports[0]);
} else {
  self.onmessage = (e: MessageEvent) => {
    if (e.data?.t === "connect") hosts.connect(e.ports[0]);
  };
}

// Constructing the store directly (rather than root.plugin) keeps it synchronous;
// it is still a Cordis service on root.
const store = new Store(root);

const notes = notesApp(root, store, hosts);

const services: Record<string, ServiceProvider> = {
  audio: {
    capability: () => "audio",
    call: (_plugin, method, args, dispatch) => hosts.bridge("audio", method, args, dispatch),
  },
  store: {
    capability: (method) => (method === "list" ? "data:read:notes" : "data:write:notes"),
    call: (_plugin, method) => {
      if (method === "list") return store.list();
      throw new Error(`store.${method} is not available to plugins yet`);
    },
  },
  kernel: {
    capability: () => undefined,
    call: (_plugin, method) => {
      if (method === "ping") return "pong";
      if (method === "hooks") return Object.fromEntries(hooks);
      throw new Error(`kernel.${method} is not a method`);
    },
  },
};

const remote = new RemotePlugins(root, hosts, services);

const BUILT_IN = [wordCount, editTimes, noShouting, tone, bars, pinger, sneaky, fetcher, offline];

let started = false;
hosts.onHello = (host, folder) => {
  if (!started) {
    started = true;
    store.use(folder);
    void notes.start();
    return;
  }
  remote.hostJoined(host);
};

hosts.onLeave = (host) => remote.hostLeft(host);

hosts.onSpawnerChange = (host) => {
  if (!host) return;
  if (!remote.installed.size) {
    for (const source of BUILT_IN) void remote.install(source);
  } else {
    record({ kind: "lifecycle", name: "spawner:handover", detail: host.tab });
    remote.spawnerChanged(host);
  }
};

hosts.onMessage = async (host, message) => {
  switch (message.t) {
    case "event":
      if (message.owner === "notes") return void notes.event(message.action, message.value, message.trace);
      return remote.deliver(message.owner, { t: "event", action: message.action, value: message.value, trace: message.trace });
    case "spawned":
      return remote.attach(message.plugin, host, message.port);
    case "canvas":
      return remote.deliver(message.owner, { t: "canvas", id: message.id, canvas: message.canvas }, [message.canvas]);
    case "command": {
      const value = await command(message.name, message.arg);
      return hosts.send(host, { t: "command:result", id: message.id, value });
    }
  }
};

async function command(name: string, arg: unknown): Promise<unknown> {
  if (name === "bench") return bench(Number(arg) || 300);
  if (name === "reload-test") return reloadTest(Number(arg) || 50);
  if (name === "reload") return remote.reload(String(arg));
  if (name === "install") return remote.install(String(arg));
  if (name === "trace") return recent();
  return undefined;
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 1000) / 1000;
};

/** Round trip of a serial hook answered by a plugin in another worker, against one answered in the kernel. */
async function bench(n: number) {
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

const hookCount = () =>
  Object.entries(root.events._hooks as Record<string, unknown[]>)
    .filter(([name]) => !name.startsWith("internal/"))
    .reduce((n, [, list]) => n + list.length, 0);

/** Reloads a sandboxed plugin many times and checks nothing is left behind. */
async function reloadTest(n: number) {
  const before = { hooks: hookCount(), workers: await hosts.bridge("host", "workerCount", []) };
  let failures = 0;
  for (let i = 0; i < n; i++) if (!(await remote.reload("word-count"))) failures++;
  // Let terminate messages reach the tab.
  await new Promise((r) => setTimeout(r, 200));
  const after = { hooks: hookCount(), workers: await hosts.bridge("host", "workerCount", []) };
  const result = { n, failures, before, after };
  record({ kind: "note", name: "reload-test", detail: JSON.stringify(result) });
  return result;
}

record({ kind: "lifecycle", name: "kernel:start", detail: shared ? "shared worker" : "dedicated worker" });
