// The kernel: Cordis core plus the bridge, the gate and the trace tap. It
// runs in a shared worker so every open tab talks to the same kernel, or in
// a dedicated worker where shared workers aren't available.
//
// Nothing in here draws UI or knows what a note is, except the two trusted
// demo plugins (store and notes) mounted at the bottom.

import { Context } from "cordis";
import { defineHook, hooks } from "./hooks";
import { Hosts } from "./hosts";
import { catalog } from "./catalog";
import { changeLog } from "./changes";
import { checkPath, PathError } from "./paths";
import { allowed, reviews as makeReviews } from "./review";
import { notesApp } from "./notes";
import { grants } from "./gate";
import { collections } from "./records";
import { reference, toMarkdown } from "./reference";
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
import tidy from "../../plugins/tidy.js?raw";

declare const SharedWorkerGlobalScope: { new (): unknown } | undefined;
const shared = typeof SharedWorkerGlobalScope !== "undefined" && self instanceof SharedWorkerGlobalScope;

const root: any = new Context();
tap(root);

// Hooks the kernel and its built-in plugins define. Plugins can define more.
const CHANGE = "{ collection, id, before?, after }";
const POST = "{ path, url, title, siteName, text, bodyStart, selection, unsaved }";
defineHook("data:changed", { mode: "emit", args: CHANGE, description: "A record was written." });
defineHook("data:beforeWrite", { mode: "serial", timeoutMs: 1000, onFailure: "open", args: CHANGE, description: "Before a record is written. Return { block: reason } to stop the write." });
defineHook("note:open", { mode: "emit", args: POST, description: "The person opened a note." });
defineHook("note:change", { mode: "emit", args: POST, description: "The person typed in the open note (unsaved is true)." });
defineHook("note:save", { mode: "emit", args: POST, description: "The open note was saved, by the person or by a reviewed write." });
defineHook("note:close", { mode: "emit", args: "null", description: "The open note was closed." });
defineHook("bench:ping", { mode: "serial", timeoutMs: 1000, onFailure: "open", args: "n", description: "Used by the round-trip benchmark; answer with anything." });

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
const log = changeLog(store);
const reviews = makeReviews(store, hosts, log);
const base = (instance: string) => instance.split("@")[0];
const titleOf = (text: string) => text.split("\n")[0].replace(/^#+\s*/, "").trim().slice(0, 60) || "Untitled";

/** Asks the person to review a write by `instance`; throws unless they allow it. */
async function reviewed(instance: string, place: string, target: string, before: string, after: string, reason: unknown, dispatch: { trace?: string }) {
  const id = base(instance);
  const outcome = await reviews.ask(
    { plugin: id, instance, name: remote.installed.get(id)?.manifest.name ?? id, place, target, before, after, reason: String(reason ?? "").slice(0, 300) },
    dispatch,
  );
  if (!allowed(outcome)) throw new Error(outcome === "rejected" ? "The person declined the change" : "Nobody answered the review, so nothing changed");
  return outcome;
}

/** Each plugin's own data: `plugin-data/<id>.json`. No review, since it is the plugin's own. */
const ownData = new Map<string, Promise<Record<string, unknown>>>();
/** A record with no prototype, so keys such as `constructor` or `__proto__` are just keys. */
const record0 = (from: unknown): Record<string, unknown> => Object.assign(Object.create(null), from && typeof from === "object" && !Array.isArray(from) ? from : {});
const dataOf = (id: string) => {
  if (!ownData.has(id)) ownData.set(id, store.readJson<unknown>(`plugin-data/${id}.json`, {}).then(record0));
  return ownData.get(id)!;
};

const services: Record<string, ServiceProvider> = {
  audio: {
    description: "Sound, played by the tab that runs the plugin workers. Audio runs in an AudioWorklet, never through hooks.",
    methods: {
      registerProcessor: { args: "(name, source)", returns: "true", needs: "audio", description: "Registers an AudioWorklet processor, from its source, under a name." },
      play: { args: "({ processor, ms?, options? })", returns: "{ played, state }", needs: "audio", description: "Plays a registered processor for `ms` milliseconds (300 by default), passing `options` as its processorOptions." },
    },
    capability: () => "audio",
    call: (_plugin, method, args, dispatch) => hosts.bridge("audio", method, args, dispatch),
  },
  store: {
    description: "The notes. They belong to the notes app, so a plugin's change to one is reviewed first.",
    methods: {
      list: { args: "()", returns: "[{ id, title, text, updated }]", needs: "data:read:notes", description: "Every note, most recently changed first." },
      put: { args: "({ id?, text }, reason)", returns: "{ ok, id, outcome }", needs: "data:write:notes", reviewed: true, description: "Creates or replaces a note. Fails if the person declines, nobody answers in five minutes, or the note changed while the review was open." },
    },
    capability: (method) => (method === "list" ? "data:read:notes" : "data:write:notes"),
    /** `put({ id?, text }, reason)`: notes belong to the notes app, so a plugin's write is reviewed first. */
    call: async (plugin, method, args, dispatch) => {
      if (method === "list") return store.list();
      if (method !== "put") throw new Error(`store.${method} is not a method`);
      const [input, reason] = args as [{ id?: unknown; text?: unknown }, unknown];
      if (!input || typeof input.text !== "string") throw new Error("store.put takes { id?, text }");
      const id = typeof input.id === "string" && /^[\w-]{1,64}$/.test(input.id) ? input.id : Math.random().toString(36).slice(2, 8);
      const before = store.get(id);
      const title = titleOf(input.text);
      const outcome = await reviewed(plugin, "notes", `the note “${before?.title ?? title}”`, before?.text ?? "", input.text, reason, dispatch);
      // Only if the note is still what the person reviewed.
      const result = await store.put({ id, title, text: input.text, updated: Date.now() }, dispatch, before?.text ?? null);
      if (!result.ok) throw new Error(`Not saved: ${result.reason}`);
      return { ok: true, id, outcome };
    },
  },
  files: {
    description: "Text files in the data folder. A path is checked first: no `..`, no hidden names, nothing in the platform's own folders.",
    methods: {
      read: { args: "(path)", returns: "text or null", needs: "files:<folder>", description: "Reads a file. `<folder>` is the path's first folder." },
      write: { args: "(path, text, reason)", returns: "{ ok, path, outcome } or { ok, unchanged }", needs: "files:<folder>", reviewed: true, description: "Writes a file, up to 5 MB. Fails if the person declines, nobody answers, or the file changed while the review was open." },
    },
    /** Each folder is its own capability: `files:exports` lets a plugin use `exports/...`. */
    capability: (_method, args) => `files:${typeof args[0] === "string" ? args[0].split("/")[0] : ""}`,
    call: async (plugin, method, args, dispatch) => {
      let path: string;
      try {
        path = checkPath(args[0]).join("/");
      } catch (error) {
        if (error instanceof PathError) record({ kind: "denied", name: "files:path", plugin, trace: dispatch.trace, detail: error.message });
        throw error;
      }
      if (method === "read") return (await store.readText(path)) ?? null;
      if (method !== "write") throw new Error(`files.${method} is not a method`);
      const text = args[1];
      if (typeof text !== "string") throw new Error("files.write takes (path, text, reason)");
      if (text.length > 5_000_000) throw new Error("The file is too large");
      const existing = await store.readText(path);
      if (existing === text) return { ok: true, unchanged: true };
      const outcome = await reviewed(plugin, `files:${path.split("/")[0]}`, path, existing ?? "", text, args[2], dispatch);
      // Written only if the file is still what the person reviewed (or still missing).
      await store.writeText(path, text, existing ?? null);
      return { ok: true, path, outcome };
    },
  },
  storage: {
    description: "The plugin's own data, kept in `plugin-data/<id>.json` with the app's data. Never reviewed, since it is the plugin's own.",
    methods: {
      get: { args: "(key)", returns: "the value, or null", description: "Reads a value." },
      set: { args: "(key, value)", returns: "true", description: "Saves a JSON value; null removes it. Up to 1 MB in all." },
    },
    capability: () => undefined,
    call: async (plugin, method, args) => {
      const id = base(plugin);
      const data = await dataOf(id);
      if (typeof args[0] !== "string") throw new Error("Storage keys are strings");
      const key = args[0];
      if (method === "get") return Object.hasOwn(data, key) ? data[key] : null;
      if (method !== "set") throw new Error(`storage.${method} is not a method`);
      // Try the change on a copy first, so a refused write leaves the stored data as it was.
      const next = record0(data);
      if (args[1] === undefined || args[1] === null) delete next[key];
      else Object.defineProperty(next, key, { value: JSON.parse(JSON.stringify(args[1])), enumerable: true, writable: true, configurable: true });
      const text = JSON.stringify(next);
      if (text.length > 1_000_000) throw new Error("A plugin's own storage is limited to 1 MB");
      await store.writeText(`plugin-data/${id}.json`, text);
      for (const k of Object.keys(data)) delete data[k];
      Object.assign(data, next);
      return true;
    },
  },
  kernel: {
    description: "The kernel itself.",
    methods: {
      ping: { args: "()", returns: '"pong"', description: "Answers at once; for checking the connection." },
      hooks: { args: "()", returns: "{ [name]: { mode, timeoutMs?, onFailure?, args?, description? } }", description: "Every hook and its contract." },
      reference: { args: "()", returns: "the reference, as data", description: "This API reference, as the kernel describes itself." },
    },
    capability: () => undefined,
    call: (_plugin, method) => {
      if (method === "ping") return "pong";
      if (method === "hooks") return Object.fromEntries(hooks);
      if (method === "reference") return describe();
      throw new Error(`kernel.${method} is not a method`);
    },
  },
};

const remote = new RemotePlugins(root, hosts, services);
const plugins = catalog(remote, store, hosts, log, reviews);
remote.onDispose = (instance) => reviews.cancelInstance(instance);
services.settings = plugins.service;
const records = collections(root, store, hosts, remote, reviewed);
remote.onManifest = records.register;
remote.readable = (instance, name) => {
  const owner = records.registry.get(name)?.owner;
  const plugin = remote.installed.get(base(instance));
  return !!plugin && !!owner && (owner === plugin.id || grants(plugin.caps, `data:read:${name}`));
};
services.data = records.service;

/** The kernel's API reference, built from the registries above as they are now. */
const describe = () => reference(services, remote);

const BUILT_IN = [wordCount, editTimes, noShouting, tone, bars, tidy, pinger, sneaky, fetcher, offline];

let started = false;
let loaded = false;
hosts.onHello = (host, folder) => {
  if (!started) {
    started = true;
    store.use(folder);
    void notes.start();
    return;
  }
  remote.hostJoined(host);
};

hosts.onLeave = (host) => {
  remote.hostLeft(host);
  records.hostLeft(host);
};

hosts.onSpawnerChange = (host) => {
  if (!host) return;
  if (!loaded) {
    loaded = true;
    void plugins.load(BUILT_IN);
  } else {
    record({ kind: "lifecycle", name: "spawner:handover", detail: host.tab });
    remote.spawnerChanged(host);
  }
};

hosts.onMessage = async (host, message) => {
  switch (message.t) {
    case "event":
      if (message.owner === "notes") return void notes.event(message.action, message.value, message.trace);
      if (message.owner === "review") return reviews.event(message.action, message.trace);
      if (message.owner === "plugins") return void plugins.event(message.action, message.value, message.trace);
      return remote.deliver(message.owner, { t: "event", action: message.action, value: message.value, trace: message.trace });
    case "spawned":
      return remote.attach(message.plugin, host, message.port);
    case "canvas":
      return remote.deliver(message.owner, { t: "canvas", id: message.id, canvas: message.canvas }, [message.canvas]);
    case "bind":
      return records.bind(host, message.id, message.owner, message.collection);
    case "unbind":
      return records.unbind(host, message.id);
    case "record":
      return records.fromView(host, message.id, message.owner, message.collection, message.recordId, message.fields, message.trace);
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
  if (name === "install") return plugins.install(String(arg));
  if (name === "uninstall") return plugins.remove(String(arg));
  if (name === "trace") return recent();
  if (name === "changes") return log.list();
  if (name === "reference") {
    const data = describe();
    return { data, markdown: toMarkdown(data), live: toMarkdown(data, { live: true }) };
  }
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
