// The kernel: Cordis core plus the bridge, the gate and the trace tap. It
// runs in a shared worker so every open tab talks to the same kernel, or in
// a dedicated worker where shared workers aren't available, or on a server
// as a space's kernel. An entry sets where (env.ts) before importing this:
// browser.ts in the browser.
//
// Nothing in here draws UI or knows about any app. It runs no plugins of its
// own: each page runs the ones it links (the notes app is site/workbench/plugins/notes.js,
// which only the workbench links).

import { Context } from "cordis";
import { env } from "./env";
import { defineHook, hooks } from "./hooks";
import { Hosts } from "./hosts";
import { apps as makeApps } from "./apps";
import { makeRoutes, type RouteRequest, type RouteResponse } from "./routes";
import { catalog } from "./catalog";
import { changeLog } from "./changes";
import { allowed, reviews as makeReviews } from "./review";
import { net } from "./net";
import { grants } from "./gate";
import { readManifest, RESERVED } from "./manifest";
import { collections } from "./records";
import { reference, toMarkdown } from "./reference";
import { RemotePlugins, type ServiceProvider } from "./remote";
import { loadServices } from "./services";
import { loadModules, type Seams } from "./modules";
import modules from "virtual:kernel-modules";
import { secrets as makeSecrets } from "./secrets";
import { Store } from "./store";
import { switches } from "./switches";
import { isolateHost } from "./isolate-host";
import { asPlugin } from "./agents/file";
import { authoring } from "./authoring";
import { record, recent, setSink, startedAt, tap } from "./trace";
import { checkApp, userPlugins } from "./user-plugins";
import type { Opened } from "../shared/protocol";


const where = env();
const shared = where.kind === "shared";

const root: any = new Context();
tap(root);

// Hooks the kernel defines here; its services define more, each collection has its own, and plugins define
// theirs in their manifests (`<plugin>:<key>`).
defineHook("debug:trace", { mode: "emit", needs: "debug:read", args: "[{ seq, at, kind, name, plugin?, trace?, ms?, detail? }]", description: "New trace events, in batches at most ten times a second. They name every plugin and what it did, so listening needs debug:read." });

const hosts = new Hosts(where.kind);
setSink((events) => {
  hosts.broadcast({ t: "trace", events });
  root.emit("debug:trace", events);
});

// The kernel's own mistakes go in the trace too, so a debug console can show them.
where.onError((name, detail) => record({ kind: "error", name, detail }));

// Wire up connections first, so no tab's connect event is missed.
// On a server, the kernel's own client that starts its plugins in isolates. It connects with the first
// client (or request), not as the kernel loads: on Cloudflare, a module's top level can't read storage.
let isolates = where.isolates;
const wake = () => {
  if (isolates) isolateHost(isolates, (own) => hosts.connect(own, { isolates: true }));
  isolates = undefined;
};
where.boot?.(wake);
where.connect((port) => {
  wake();
  hosts.connect(port);
});

// The data folder. Constructing it directly (rather than root.plugin) keeps it synchronous;
// it is still a Cordis service on root.
const store = new Store(root);

const log = changeLog(store);
const reviews = makeReviews(store, hosts, log);
const base = (instance: string) => instance.split("@")[0];

/** Asks the person to review a write by `instance`; throws unless they allow it. */
async function reviewed(instance: string, place: string, target: string, before: string, after: string, reason: unknown, dispatch: { trace?: string }, options: { once?: boolean } = {}) {
  const id = base(instance);
  const outcome = await reviews.ask(
    { plugin: id, instance, name: remote.installed.get(id)?.manifest.name ?? id, place, target, before, after, reason: String(reason ?? "").slice(0, 300), ...(options.once ? { once: true } : {}) },
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
  // Kernel modules hear it as internal/stopped on their own context (root.on), so their listener goes with them.
  root.emit("internal/stopped", instance);
};
services.settings = plugins.service;
const records = collections(root, store, hosts, remote, reviewed);
const apps = makeApps(remote, hosts, plugins.isOff);
const userAdded = userPlugins(store, where.origin, where.kind === "server" ? undefined : where.space);
/**
 * Spaces (sync with a space, its server's apps, members' shared plugins and reviews) are the spaces module's
 * (std/spaces/module.ts): it answers `sync` messages and lends the core what a space adds, here.
 */
const seams: Seams = { messages: new Map(), space: {} };
const space = () => seams.space.current;

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
  shared: () => space()?.sharing,
  origin: where.origin,
  services: () => Object.keys(services),
  page: (tab, method, args, dispatch) => {
    const host = hosts.list.find((h) => h.tab === tab);
    if (!host) throw new Error("That tab has closed");
    return hosts.bridge("customize", method, args, dispatch, host);
  },
  unlock: async (app, plugin, place, on) => {
    const grant = `unlock:${app}#${place}`;
    if (on) await reviews.grant(plugin, grant);
    else await reviews.forget(plugin, grant);
    await reopen(app);
  },
});

/**
 * Opens an app in a tab: the plugins its app.html links, and the person's own plugins for it that are
 * on. The tab hears each plugin's places, and which locked places the person let it into.
 */
async function openApp(host: (typeof hosts.list)[number], links: { href: string; source: string; runner?: string }[], app?: string) {
  // A device new to a space gets what the space has before its app starts, so the app sees the space's data.
  await space()?.ready?.();
  if (!hosts.list.includes(host)) return;
  let mine: { href: string; source: string }[] = [];
  let ids = new Set<string>();
  try {
    if (app !== undefined) {
      checkApp(app);
      // In a space, the space hears which app is open, so the plugins of it that run on the server start there.
      space()?.use?.(app);
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
// On a server, the host passes on HTTP requests for the routes its plugins added: public, so a form or a
// webhook can reach the space. A route that isn't there yet may be one a plugin of a space just woken is
// about to add, so the request waits while the space's apps are starting (and a little after), up to 10 s.
where.serve?.(async (request) => {
  wake();
  // A door the host let in (an MCP request from a member's agent, src/server/mcp.ts): the module that answers
  // it answers that door (ModuleKernel.door). Its plugins may still be starting, as for a route.
  if (typeof request.door === "string") {
    const answer = doors.get(request.door);
    if (!answer) return null;
    const deadline = Date.now() + 10_000;
    while (space()?.server?.starting() && Date.now() < deadline) await Promise.race([space()!.server!.settled(), new Promise((r) => setTimeout(r, 250))]);
    return (await answer(request)) as RouteResponse | null;
  }
  // A HEAD request is answered by a HEAD route if a plugin has one, else by its GET route.
  const keys = request.method === "HEAD" ? [`HEAD ${request.path}`, `GET ${request.path}`] : [`${request.method} ${request.path}`];
  const found = () => keys.find((key) => remote.routes.includes(key));
  const deadline = Date.now() + 10_000;
  let starting = !found() && space()?.server?.starting();
  while (!found() && Date.now() < deadline) {
    const finished = Number((await Promise.race([space()?.server?.settled(), new Promise<undefined>((r) => setTimeout(r, 250))])) ?? 0);
    starting = space()?.server?.starting();
    // Settled, and long enough since for a plugin's code to have added its routes: there's no such route.
    if (!starting && Date.now() - (finished || space()?.server?.finishedAt() || 0) > 3000) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const key = found();
  if (!key) return starting ? { status: 503, text: "The space is still starting: try again in a moment" } : null;
  return routes.answer({ ...request, method: key.slice(0, key.indexOf(" ")) });
});
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

// The rest of the core's services are a file each in services/, found by name.
const parts = { root, store, hosts, remote, apps, reviewed, describe, collections: records, reviews, userAdded, reopen, started: () => started };
Object.assign(services, loadServices(parts));
// Then the kernel modules the site lists in kernel.json (docs/layers.md): each may add services and page commands.
/** The page commands the kernel answers itself; a module's commands (loadModules) can't take these names. */
const CORE_COMMANDS = new Set(["changes", "install", "reference", "reload", "restart-module", "route", "trace", "uninstall"]);

const commands = new Map<string, (arg: unknown) => unknown>();
/** What the modules answer at the server's doors (ModuleKernel.door). */
const doors = new Map<string, (request: RouteRequest) => Promise<RouteResponse | null> | RouteResponse | null>();
const kernelModules = loadModules(modules, parts, services, commands, doors, (name) => CORE_COMMANDS.has(name) || /^(user|place):/.test(name), seams);
// A space's server is nothing without its spaces: no module answering sync is a site that can't serve one. Fail, never go without.
if (hosts.mode === "server") void kernelModules.ready.then(() => {
  if (!seams.messages.has("sync")) record({ kind: "error", name: "kernel:no-spaces", detail: "This is a space's server, but kernel.json lists no module that answers sync (std/spaces)" });
});
// A plugin can't take a service's name as its id, whichever way the service was added.
for (const name of Object.keys(services)) RESERVED.add(name);


let started = false;
let loaded = false;
hosts.onHello = (host, folder) => {
  if (!started) {
    started = true;
    store.use(where.folder ?? folder);
    // Modules that wait for the data folder (the spaces module's sync with a space) start their part now.
    root.emit("internal/started");
    return;
  }
  remote.hostJoined(host);
};

hosts.onLeave = (host) => {
  remote.hostLeft(host);
  records.hostLeft(host);
  apps.hostLeft(host);
  root.emit("internal/left", host);
  openApps.delete(host.tab);
};

hosts.onSpawnerChange = (host) => {
  if (!host) return;
  if (!loaded) {
    loaded = true;
    // The kernel has no plugins of its own: a page links the ones it uses (the workbench links plugins/).
    void plugins.load([]);
  } else {
    record({ kind: "lifecycle", name: "spawner:handover", detail: host.tab });
    remote.spawnerChanged(host);
  }
};

hosts.onMessage = async (host, message) => {
  switch (message.t) {
    case "event":
      if (message.owner === "review") return reviews.event(message.action, message.trace);
      if (message.owner === "secrets") return secrets.event(message.action, message.value);
      if (message.owner === "plugins") return void plugins.event(message.action, message.value, message.trace);
      {
        // The page may name a plugin rather than its instance (it tells a plugin its place changed): a tab-scoped one is this tab's.
        const owner = remote.live.has(message.owner) || message.owner.includes("@") ? message.owner : `${message.owner}@${host.tab}`;
        return remote.deliver(remote.live.has(owner) ? owner : message.owner, { t: "event", action: message.action, value: message.value, trace: message.trace });
      }
    case "spawned":
      // On a server only the kernel's own isolate host starts plugins; a member's client can't hand it one.
      if (hosts.mode === "server" && host !== hosts.spawner) return;
      return remote.attach(message.plugin, host, message.port);
    case "canvas":
      return remote.deliver(message.owner, { t: "canvas", id: message.id, canvas: message.canvas, theme: message.theme }, [message.canvas]);
    case "canvas:theme":
      return remote.deliver(message.owner, { t: "canvas:theme", theme: message.theme });
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
        if (message.reset) await plugins.turnOn(message.plugins.flatMap(({ href, source: linked, runner }) => {
          try {
            const source = asPlugin(href, linked, runner);
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
      // The router module, if the site runs it, keeps the screen with the tab and tells plugins (std/router/module.ts).
      return void root.emit("internal/url", host, message.path, message.query, openApps.get(host.tab)?.app);
    case "report":
      return record({ kind: "error", name: `page:${String(message.source).slice(0, 40)}`, detail: `tab ${host.tab}: ${String(message.text).slice(0, 2000)}` });
    case "command": {
      const value = await command(message.name, message.arg);
      return hosts.send(host, { t: "command:result", id: message.id, value });
    }
    default: {
      // A message a module answers (ModuleKernel.message): `sync`, from a device in a space.
      const answer = seams.messages.get((message as { t: string }).t);
      if (answer) return answer(host, message);
    }
  }
};

async function command(name: string, arg: unknown): Promise<unknown> {
  const added = commands.get(name);
  if (added) return added(arg);
  if (name === "reload") return remote.reload(String(arg));
  // Stops a kernel module and the ones that use it, then starts them again: what it added must come and go with it.
  if (name === "restart-module") return kernelModules.restart(String(arg)).then(() => ({ ok: true }), (error) => ({ ok: false, error: String(error?.message ?? error) }));
  if (name === "install") return plugins.install(String(arg));
  if (name === "uninstall") return plugins.remove(String(arg));
  if (name === "trace") return recent();
  if (name === "route") return routes.answer(arg);
  if (name === "changes") return log.list();
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
    {
      const sharing = space()?.sharing;
      return sharing ? sharing.mark(app, await userAdded.list(app)) : userAdded.list(app);
    }
    case "user:share":
    case "user:unshare": {
      const sharing = space()?.sharing;
      if (!sharing) return { ok: false, error: "Only a plugin in a space can be shared with it" };
      return { ok: await (name === "user:share" ? sharing.share(app, id) : sharing.unshare(app, id)) };
    }
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

record({ kind: "lifecycle", name: "kernel:start", detail: { shared: "shared worker", dedicated: "dedicated worker", server: "space kernel" }[where.kind] });
