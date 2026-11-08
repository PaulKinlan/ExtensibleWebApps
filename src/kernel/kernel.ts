// The kernel: Cordis core plus the bridge, the gate and the trace tap. It
// runs in a shared worker so every open tab talks to the same kernel, or in
// a dedicated worker where shared workers aren't available, or on a server
// as a space's kernel. An entry sets where (env.ts) before importing this:
// browser.ts in the browser.
//
// Nothing in here draws UI or knows what a note is, except the two trusted
// demo plugins (store and notes) mounted at the bottom.

import { Context } from "cordis";
import { env } from "./env";
import { defineHook, hooks } from "./hooks";
import { Hosts } from "./hosts";
import { apps as makeApps } from "./apps";
import { makeRoutes } from "./routes";
import { catalog } from "./catalog";
import { changeLog } from "./changes";
import { allowed, reviews as makeReviews } from "./review";
import { net } from "./net";
import { notesApp } from "./notes";
import { grants } from "./gate";
import { readManifest, RESERVED } from "./manifest";
import { collections } from "./records";
import { reference, toMarkdown } from "./reference";
import { RemotePlugins, type ServiceProvider } from "./remote";
import { loadServices } from "./services";
import { routed } from "./services/router";
import { secrets as makeSecrets } from "./secrets";
import { Store } from "./store";
import { switches } from "./switches";
import { syncHub } from "./sync";
import { syncDevice } from "./sync-device";
import { asPlugin } from "./agents/file";
import { authoring } from "./authoring";
import { record, recent, setSink, startedAt, tap } from "./trace";
import { checkApp, userPlugins } from "./user-plugins";
import type { Opened } from "../shared/protocol";

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

const where = env();
const shared = where.kind === "shared";

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
defineHook("debug:trace", { mode: "emit", needs: "debug:read", args: "[{ seq, at, kind, name, plugin?, trace?, ms?, detail? }]", description: "New trace events, in batches at most ten times a second. They name every plugin and what it did, so listening needs debug:read." });
defineHook("bench:ping", { mode: "serial", timeoutMs: 1000, onFailure: "open", args: "n", description: "Used by the round-trip benchmark; answer with anything." });

const hosts = new Hosts(where.kind);
setSink((events) => {
  hosts.broadcast({ t: "trace", events });
  root.emit("debug:trace", events);
});

// The kernel's own mistakes go in the trace too, so a debug console can show them.
where.onError((name, detail) => record({ kind: "error", name, detail }));

// Wire up connections first, so no tab's connect event is missed.
where.connect((port) => hosts.connect(port));

// Constructing the store directly (rather than root.plugin) keeps it synchronous;
// it is still a Cordis service on root.
const store = new Store(root);

const notes = notesApp(root, store, hosts);
const log = changeLog(store);
const reviews = makeReviews(store, hosts, log);
const base = (instance: string) => instance.split("@")[0];

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

// Services set here belong to a module made below; every other service is a file in services/.
const services: Record<string, ServiceProvider> = {};

const remote = new RemotePlugins(root, hosts, services);
const secrets = makeSecrets(store, hosts, (instance) => remote.installed.get(base(instance))?.manifest.name ?? base(instance));
services.secrets = secrets.service;
services.net = net(secrets, (instance) => remote.installed.get(base(instance))?.caps ?? new Set());
const plugins = catalog(remote, store, hosts, log, reviews);
remote.onDispose = (instance) => {
  reviews.cancelInstance(instance);
  secrets.cancelInstance(instance);
};
services.settings = plugins.service;
const records = collections(root, store, hosts, remote, reviewed);
const apps = makeApps(remote, hosts, plugins.isOff);
const sync = syncHub(root, store, records, hosts);
/** In a browser kernel for a space (a page at /s/<space>/…): its sync with the space, once the folder is known. */
let device: ReturnType<typeof syncDevice> | undefined;
const userAdded = userPlugins(store, where.origin, where.kind === "server" ? undefined : where.space);

/** For each tab with an app open: the app's folder and the plugins its app.html links, to open it again. */
const openApps = new Map<string, { app?: string; links: { href: string; source: string }[] }>();
/** Tabs whose app is still opening: their address waits for it (see the `url` message). */
const opening = new Map<string, Promise<void>>();
services.authoring = authoring(remote, apps, {
  store,
  userAdded,
  appIn: (tab) => openApps.get(tab)?.app,
  ask: (request, dispatch) => reviews.ask(request, dispatch),
  reopen: (app) => reopen(app),
  turnOn: (ids) => plugins.turnOn(ids),
});

/**
 * Opens an app in a tab: the plugins its app.html links, and the person's own plugins for it that are
 * on. The tab hears each plugin's places, and which locked places the person let it into.
 */
async function openApp(host: (typeof hosts.list)[number], links: { href: string; source: string }[], app?: string) {
  // A device new to a space gets what the space has before its app starts, so the app sees the space's data.
  await device?.ready;
  if (!hosts.list.includes(host)) return;
  let mine: { href: string; source: string }[] = [];
  let ids = new Set<string>();
  try {
    if (app !== undefined) {
      checkApp(app);
      mine = await userAdded.links(app);
      ids = await userAdded.ids(app);
    }
  } catch {
    app = undefined;
  }
  openApps.set(host.tab, { app, links });
  const describe = (o: Opened): Opened => {
    if (!o.id) return o;
    const installed = remote.installed.get(o.id);
    // A plugin turned off (in the workbench, say) changes nothing in the page.
    const manifest = installed?.enabled ? installed.manifest : undefined;
    const unlocked = app ? reviews.grantsFor(o.id).flatMap((g) => (g.startsWith(`unlock:${app}#`) ? [g.split("#")[1]] : [])) : [];
    return { ...o, name: installed?.manifest.name, places: manifest?.places, theme: manifest?.theme, unlocked, user: ids.has(o.id) };
  };
  await apps.open(host, [...links, ...mine], describe);
}

/** Opens an app again in every tab that has it open, after its user plugins or places changed. */
async function reopen(app: string) {
  for (const host of hosts.list) {
    const open = openApps.get(host.tab);
    if (open?.app === app) {
      await openApp(host, open.links, app);
      // What the app links changed, and its plugins are running now: plugins.app() and llm.providers() answer differently.
      pluginSwitches.opened(host.tab);
    }
  }
}

// A plugin turned on or off anywhere: the tabs whose apps use it hear again, so its places come or go.
const notify = remote.onChange;
remote.onChange = (change, id) => {
  notify?.(change, id);
  if (change !== "enable" && change !== "disable") return;
  for (const host of hosts.list) {
    const open = openApps.get(host.tab);
    if (open && apps.linkedBy(host.tab)?.includes(id)) void openApp(host, open.links, open.app);
  }
};

const routes = makeRoutes(root, remote, shared, where.space);
remote.onManifest = records.register;
remote.readable = (instance, name) => {
  const owner = records.registry.get(name)?.owner;
  const plugin = remote.installed.get(base(instance));
  // A collection no plugin has made yet is readable by a plugin that may read it, so it can listen ahead.
  return !!plugin && (owner === plugin.id || grants(plugin.caps, `data:read:${name}`));
};
remote.collectionOwner = (name) => records.registry.get(name)?.owner;
services.data = records.service;
const pluginSwitches = switches(root, remote, apps);
services.plugins = pluginSwitches.service;

/** The kernel's API reference, built from the registries above as they are now. */
const describe = () => reference(services, remote);

// The rest of the services are a file each in services/, found by name.
Object.assign(services, loadServices({ root, store, hosts, remote, apps, reviewed, describe, collections: records }));
// A plugin can't take a service's name as its id, whichever way the service was added.
for (const name of Object.keys(services)) RESERVED.add(name);

// One per line, with a trailing comma, so two changes that add a plugin land on different lines.
const BUILT_IN = [
  wordCount,
  editTimes,
  noShouting,
  tone,
  bars,
  tidy,
  pinger,
  sneaky,
  fetcher,
  offline,
];

let started = false;
let loaded = false;
hosts.onHello = (host, folder) => {
  if (!started) {
    started = true;
    store.use(where.folder ?? folder);
    void notes.start();
    if (where.space && where.kind !== "server") device = syncDevice(`${where.origin.replace(/^http/, "ws")}/s/${where.space}/kernel`, store, records, hosts);
    return;
  }
  remote.hostJoined(host);
};

hosts.onLeave = (host) => {
  remote.hostLeft(host);
  records.hostLeft(host);
  apps.hostLeft(host);
  sync.hostLeft(host);
  openApps.delete(host.tab);
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
      if (message.owner === "secrets") return secrets.event(message.action, message.value);
      if (message.owner === "plugins") return void plugins.event(message.action, message.value, message.trace);
      {
        // The page may name a plugin rather than its instance (it tells a plugin its place changed): a tab-scoped one is this tab's.
        const owner = remote.live.has(message.owner) || message.owner.includes("@") ? message.owner : `${message.owner}@${host.tab}`;
        return remote.deliver(remote.live.has(owner) ? owner : message.owner, { t: "event", action: message.action, value: message.value, trace: message.trace });
      }
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
    case "open": {
      // The tab's first screen waits for this, so router:changed knows the app and its plugins.
      let opened!: () => void;
      opening.set(host.tab, new Promise<void>((resolve) => (opened = resolve)));
      try {
        // An app's plugins may read collections whose owners aren't running: know those first.
        // Opened with ?reset: the app's plugins the person turned off come back on first.
        // Only plugins this app may load: not one whose id belongs to a different running plugin.
        if (message.reset) await plugins.turnOn(message.plugins.flatMap(({ href, source: linked }) => {
          try {
            const source = asPlugin(href, linked);
            const id = readManifest(source).id;
            const running = remote.installed.get(id);
            return !running || running.source === source ? [id] : [];
          } catch {
            return [];
          }
        }));
        await records.ready;
        // openApp checks the tab is still open: it may have closed while waiting.
        await openApp(host, message.plugins, message.app);
        // Its tab-scoped plugins may have started before the app said what it links: tell them it has.
        return pluginSwitches.opened(host.tab);
      } finally {
        opened();
        opening.delete(host.tab);
      }
    }
    case "url":
      await opening.get(host.tab);
      return routed(host, message.path, message.query, openApps.get(host.tab)?.app);
    case "report":
      return record({ kind: "error", name: `page:${String(message.source).slice(0, 40)}`, detail: `tab ${host.tab}: ${String(message.text).slice(0, 2000)}` });
    case "sync":
      return sync.handle(host, message);
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
  if (name === "route") return routes.answer(arg);
  if (name === "changes") return log.list();
  if (name === "sync") return device ? device.state() : { space: false };
  // The panel's commands answer { ok: false, error } rather than throw, so the page always hears back.
  if (name.startsWith("user:") || name.startsWith("place:")) return customize(name, arg).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  if (name === "reference") {
    const data = describe();
    return { data, markdown: toMarkdown(data), live: toMarkdown(data, { live: true }) };
  }
  return undefined;
}

/** The Customize panel's commands: the person's own plugins for an app, and the places they let plugins into. */
async function customize(name: string, arg: unknown): Promise<unknown> {
  const a = (arg ?? {}) as Record<string, unknown>;
  const app = checkApp(a.app);
  const id = typeof a.id === "string" ? a.id : typeof a.plugin === "string" ? a.plugin : "";
  switch (name) {
    case "user:list":
      return userAdded.list(app);
    case "user:add": {
      const added = typeof a.url === "string" ? await userAdded.addFromUrl(app, a.url) : await userAdded.add(app, a.files as { name: string; data: Blob | string }[]);
      // Adding a plugin again turns it off: stop the copy that was running.
      await reopen(app);
      return added;
    }
    case "user:on":
    case "user:off":
      await (name === "user:on" ? userAdded.on(app, id) : userAdded.off(app, id));
      await reopen(app);
      return true;
    case "user:remove": {
      const removed = await userAdded.remove(app, id);
      await reopen(app);
      return removed;
    }
    case "place:ask": {
      const outcome = await reviews.ask(
        {
          plugin: id,
          instance: id,
          name: remote.installed.get(id)?.manifest.name ?? id,
          place: `place:${app}#${String(a.place)}`,
          target: String(a.target ?? "the page").slice(0, 120),
          before: "",
          after: "",
          reason: String(a.what ?? "").slice(0, 300),
          kind: "place",
        },
        {},
      );
      return allowed(outcome);
    }
    case "place:unlock":
    case "place:lock": {
      const place = `unlock:${app}#${String(a.place)}`;
      if (name === "place:unlock") await reviews.grant(id, place);
      else await reviews.forget(id, place);
      await reopen(app);
      return true;
    }
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

record({ kind: "lifecycle", name: "kernel:start", detail: { shared: "shared worker", dedicated: "dedicated worker", server: "space kernel" }[where.kind] });
