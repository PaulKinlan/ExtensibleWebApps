// Sandboxed plugins. Each instance runs in its own dedicated worker; the
// kernel holds a port to it and a Cordis fiber that owns every listener
// registered on its behalf, so unloading it disposes all of them at once.
//
// The manifest is read from the source before anything runs, and the gate
// uses that copy: what a plugin reports about itself at run time must match.
//
// A plugin's `scope` decides how many instances run. "shared" (the default)
// runs one, in the spawner tab, for every tab. "tab" runs one per open tab;
// its views go only to its own tab, and it can draw on canvases there.
//
// Hooks are carried across the port according to their spec: `emit` and
// `parallel` are posted and forgotten; `serial`, `bail` and `waterfall`
// wait for the plugin's answer within the hook's time limit, and apply the
// hook's failure policy when it doesn't come. The trace id rides along as
// Cordis's `thisArg`, so it survives awaits.

import type { Dispatch, KernelToPlugin, Manifest, PluginToKernel, Slot, View } from "../shared/protocol";
import { HTML_MAX } from "../shared/html";
import { made } from "./agents/file";
import { capabilities, check, grants } from "./gate";
import { BEFORE_WRITE, capabilityFor, defineHook, hookOwners, hooks, kernelPrefix, PLUGIN_HOOKS, type HookSpec } from "./hooks";
import type { Host, Hosts } from "./hosts";
import { ManifestError, readManifest } from "./manifest";
import type { Schema } from "./schema";
import { record } from "./trace";
import { env } from "./env";
import { providedService, serviceHook, SERVICE_TIMEOUT_MS } from "./provided";

/**
 * One argument of a service method, so a model can call it as a tool
 * (services/tools.ts). The order of a method's params is the order of its
 * arguments.
 */
export interface Param {
  name: string;
  /** What the value must be, in the collections' JSON Schema subset. No type means any JSON value. */
  schema: Schema;
  /** True if it may be left out. Only trailing arguments can be. */
  optional?: boolean;
  /**
   * A capability prefix, such as `data:read:`, whose names this value must be
   * one of. A tool list then offers only the names the caller holds (and, for
   * `data:` prefixes, the collections its manifest owns).
   */
  names?: string;
  /**
   * The name of a `names` param that holds a collection: this value is a
   * record of that collection. When a tool is made for one collection, this
   * argument takes the collection's own schema.
   */
  recordOf?: string;
}

/** One method of a service, as the API reference shows it. */
export interface MethodDoc {
  /** The arguments after the method name, e.g. `(path, text, reason)`. */
  args: string;
  returns: string;
  /** The capability it needs, as a reader should see it (`files:<folder>`); none if it needs nothing. */
  needs?: string;
  /** True if the person reviews the change before it happens. */
  reviewed?: boolean;
  description: string;
  /** Its arguments, described for tools. A method without them isn't offered as a tool. */
  params?: Param[];
}

export interface ServiceProvider {
  description: string;
  /** Every method the service has. A method that isn't listed here can't be called, so the reference is the whole API. */
  methods: Record<string, MethodDoc>;
  /** Capability a plugin needs to call this method. */
  capability(method: string, args: unknown[]): string | undefined;
  call(plugin: string, method: string, args: unknown[], dispatch: Dispatch): Promise<unknown> | unknown;
}

/** Where a plugin came from: bundled with the platform, kept in the data folder, linked by an open app's app.html, or an app's server plugin. */
/** "server": an app's plugin that runs on a space's server (server-apps.ts), the only kind that runs there. */
export type Origin = "built-in" | "data" | "app" | "server";

export interface Installed {
  id: string;
  source: string;
  manifest: Manifest;
  caps: Set<string>;
  origin: Origin;
  /** A plugin that is turned off stays installed but runs no instances. */
  enabled: boolean;
  /** Where an app's plugin was loaded from; its view templates are files next to it. */
  href?: string;
}

export type InstallResult = { ok: true; id: string; started: boolean } | { ok: false; error: string };

type Waiter = { resolve: (ok: boolean) => void };

const ms = (since: number) => Math.round((performance.now() - since) * 100) / 100;

export class RemotePlugins {
  readonly installed = new Map<string, Installed>();
  /** Services plugins provide (provided.ts): which plugin provides each. */
  readonly providers = new Map<string, string>();
  /** Services an app that is opening will provide, by name, counted: a plugin beside them that needs one may start first. */
  readonly expected = new Map<string, number>();
  readonly live = new Map<string, Remote>();
  private waiting = new Map<string, Waiter[]>();
  /** Told when plugins are installed, removed, or turned on or off. */
  onChange?: (change: "install" | "uninstall" | "enable" | "disable", id: string) => void;
  /** Told about each manifest as it is installed, before the plugin starts. */
  onManifest?: (manifest: Manifest) => void;
  /** Whether an instance may read a collection; listening to its hooks needs that too. */
  readable?: (instance: string, collection: string) => boolean;
  /** The plugin that owns a collection, from the registry rather than any manifest's claim. */
  collectionOwner?: (collection: string) => string | undefined;
  /** Told whenever an instance's worker goes, for any reason. */
  onDispose?: (instance: string) => void;
  /** Told when a running plugin adds or drops a route, or stops: `routes` has changed. */
  onRoutes?: () => void;

  /** Every route the running plugins answer, as "GET /demos/app/path". */
  get routes(): string[] {
    const all = new Set<string>();
    for (const remote of this.live.values()) for (const name of remote.heard) if (name.startsWith("route:")) all.add(name.slice(6));
    return [...all].sort();
  }

  constructor(
    readonly root: any,
    readonly hosts: Hosts,
    readonly services: Record<string, ServiceProvider>,
  ) {}

  /** Installs (or replaces) a plugin from its source and starts it. The manifest is read without running the code. */
  async install(source: string, options: { origin?: Origin; enabled?: boolean; href?: string } = {}): Promise<InstallResult> {
    let manifest: Manifest;
    try {
      manifest = readManifest(source);
    } catch (error) {
      const message = error instanceof ManifestError ? error.message : String(error);
      record({ kind: "error", name: "plugin:refused", detail: message });
      return { ok: false, error: message };
    }
    // On a space's server only the site's own plugins are installed (server-apps.ts) and the kernel's
    // built-in ones: not one a member's client sent (an app's link, a plugin they added), which could
    // otherwise claim a collection before the space's own plugin does.
    if (this.hosts.mode === "server" && (options.origin === "app" || options.origin === "data" || options.origin === undefined)) {
      const message = `On a space's server only the site's own plugins are installed, not “${manifest.id}”`;
      record({ kind: "error", name: "plugin:refused", detail: message });
      return { ok: false, error: message };
    }
    const previous = this.installed.get(manifest.id);
    // A space's server plugin is replaced only by the site's own copy, never by one a member's client sent.
    if (previous?.origin === "server" && options.origin !== "server") {
      const message = `“${manifest.id}” is one of the space's server plugins`;
      record({ kind: "error", name: "plugin:refused", detail: message });
      return { ok: false, error: message };
    }
    // A plugin that needs a service this site doesn't run fails now, saying which, not on its first call.
    const provides = Object.keys(manifest.provides ?? {});
    const missing = (manifest.services ?? []).filter((name) => !Object.hasOwn(this.services, name) && !this.expected.has(name) && !provides.includes(name));
    if (missing.length) {
      const message = `“${manifest.name}” needs the ${missing.join(", ")} service${missing.length > 1 ? "s" : ""}, which nothing here provides: add ${missing.length > 1 ? "them" : "it"} to kernel.json, or link a plugin that provides ${missing.length > 1 ? "them" : "it"}`;
      record({ kind: "error", name: "plugin:refused", detail: message });
      return { ok: false, error: message };
    }
    // A service name the kernel, a module or another plugin has is refused, never shadowed.
    const clash = provides.find((name) => Object.hasOwn(this.services, name) && this.providers.get(name) !== manifest.id);
    if (clash) {
      const by = this.providers.get(clash);
      const message = `“${manifest.name}” can't provide ${clash}: ${by ? `the plugin ${by} already does` : "the kernel already has a service by that name"}`;
      record({ kind: "error", name: "plugin:refused", detail: message });
      return { ok: false, error: message };
    }
    // A plugin's hooks are named after it: one the kernel already has can't be taken.
    const taken = Object.keys(manifest.hooks ?? {}).map((key) => `${manifest.id}:${key}`).find((name) => hooks.has(name) && hookOwners.get(name) !== manifest.id);
    if (taken) {
      const message = `The hook ${taken} is the kernel's`;
      record({ kind: "error", name: "plugin:refused", detail: message });
      return { ok: false, error: message };
    }
    this.stop(manifest.id);
    const enabled = options.enabled ?? previous?.enabled ?? true;
    this.installed.set(manifest.id, { id: manifest.id, source, manifest, caps: capabilities(manifest), origin: options.origin ?? "data", enabled, href: options.href });
    this.defineHooks(manifest.id, manifest.hooks ?? {});
    this.provideServices(manifest);
    this.onManifest?.(manifest);
    record({ kind: "lifecycle", name: "plugin:install", plugin: manifest.id, detail: `${manifest.scope ?? "shared"}: ${manifest.permissions.join(" ")}${enabled ? "" : " (off)"}` });
    this.onChange?.("install", manifest.id);
    return { ok: true, id: manifest.id, started: enabled && (await this.start(manifest.id)) };
  }

  /** Starts every instance a plugin needs. Resolves true when all of them are running. */
  async start(id: string): Promise<boolean> {
    const plugin = this.installed.get(id);
    if (!plugin?.enabled) return false;
    if (!this.runsHere(plugin)) return false;
    const targets = this.targets(plugin);
    const started = await Promise.all(targets.map(([instance, host]) => this.startInstance(plugin, instance, host)));
    return started.length > 0 && started.every(Boolean);
  }

  /**
   * On a server only the plugins of the apps opened in the space run, as the site serves them
   * (server-apps.ts): never source a member's client sent (an app it says it opened, a plugin it added).
   */
  private runsHere(plugin: Installed): boolean {
    if (this.hosts.mode === "server") return plugin.origin === "server";
    // And in a browser, never a plugin that runs only on the server, however it was installed.
    return plugin.manifest.runs !== "server";
  }

  /** A plugin with an instance per tab. A server has no tabs: there one instance runs, as a shared plugin's does. */
  private perTab(plugin: Installed): boolean {
    return plugin.manifest.scope === "tab" && this.hosts.mode !== "server";
  }

  /**
   * The tabs a tab-scoped plugin runs in, when not every tab: an app's plugin runs only in the tabs whose
   * app links it (apps.ts sets this). Undefined means every tab, as for a plugin kept with the data.
   */
  tabsFor?: (id: string) => string[] | undefined;

  /** The tabs a tab-scoped plugin may have an instance in. */
  private allowedIn(plugin: Installed, host: Host): boolean {
    const tabs = this.tabsFor?.(plugin.id);
    return !tabs || tabs.includes(host.tab);
  }

  private targets(plugin: Installed): [string, Host][] {
    if (this.perTab(plugin)) return this.hosts.workerHosts.filter((host) => this.allowedIn(plugin, host)).map((host) => [`${plugin.id}@${host.tab}`, host]);
    const spawner = this.hosts.spawner;
    return spawner ? [[plugin.id, spawner]] : [];
  }

  private startInstance(plugin: Installed, instance: string, host: Host): Promise<boolean> {
    record({ kind: "lifecycle", name: "plugin:spawn", plugin: instance, detail: `in tab ${host.tab}` });
    this.hosts.send(host, { t: "spawn", plugin: instance, source: plugin.source, network: plugin.caps.has("network") });
    return new Promise((resolve) => {
      const waiter: Waiter = { resolve };
      const list = this.waiting.get(instance) ?? [];
      list.push(waiter);
      this.waiting.set(instance, list);
      setTimeout(() => {
        const current = this.waiting.get(instance);
        if (!current?.includes(waiter)) return;
        current.splice(current.indexOf(waiter), 1);
        record({ kind: "error", name: "plugin:start-timeout", plugin: instance });
        resolve(false);
      }, 5000);
    });
  }

  /** A tab created the worker for `instance` and passed its port. */
  attach(instance: string, host: Host, port: MessagePort): void {
    const id = instance.split("@")[0];
    const plugin = this.installed.get(id);
    if (!plugin?.enabled) {
      // Removed or turned off while its worker was starting: don't keep it.
      port.close();
      this.hosts.send(host, { t: "terminate", plugin: instance });
      this.settle(instance, false);
      return;
    }
    this.live.get(instance)?.dispose();
    this.live.set(instance, new Remote(instance, plugin, host, port, this));
  }

  settle(instance: string, ok: boolean): void {
    for (const waiter of this.waiting.get(instance) ?? []) waiter.resolve(ok);
    this.waiting.delete(instance);
  }

  /** Stops every instance of a plugin. */
  stop(id: string): void {
    for (const [instance, remote] of this.live) if (remote.plugin.id === id) this.stopInstance(instance);
  }

  stopInstance(instance: string, terminate = true): void {
    const remote = this.live.get(instance);
    if (!remote) return;
    remote.dispose();
    this.live.delete(instance);
    this.hosts.clear(instance);
    if (terminate && this.hosts.list.includes(remote.host)) this.hosts.send(remote.host, { t: "terminate", plugin: instance });
    record({ kind: "lifecycle", name: "plugin:stop", plugin: instance });
  }

  /**
   * Defines a plugin's own hooks, `<id>:<key>`, from its manifest, in place of the ones it had. Listeners
   * waiting for one (they listened before the plugin was installed) start hearing it, and the listeners of
   * a hook that goes wait for it again.
   */
  private defineHooks(id: string, wanted: NonNullable<Manifest["hooks"]>): void {
    const next = new Map<string, HookSpec>();
    for (const [key, h] of Object.entries(wanted)) {
      const waits = h.mode !== "emit" && h.mode !== "parallel";
      next.set(`${id}:${key}`, {
        mode: h.mode,
        ...(h.args ? { args: h.args } : {}),
        ...(h.description ? { description: h.description } : {}),
        ...(waits ? { timeoutMs: Math.min(h.timeoutMs ?? PLUGIN_HOOKS.defaultTimeoutMs, PLUGIN_HOOKS.timeoutMs), onFailure: h.onFailure ?? "open" } : {}),
        ...(waits && h.agentTimeoutMs ? { agentTimeoutMs: Math.min(h.agentTimeoutMs, PLUGIN_HOOKS.agentTimeoutMs) } : {}),
      });
    }
    for (const [name, owner] of hookOwners) {
      if (owner !== id || JSON.stringify(hooks.get(name)) === JSON.stringify(next.get(name))) continue;
      hooks.delete(name);
      hookOwners.delete(name);
      for (const remote of this.live.values()) remote.hookGone(name);
    }
    for (const [name, spec] of next) {
      if (hookOwners.get(name) === id) continue;
      defineHook(name, spec);
      hookOwners.set(name, id);
      for (const remote of this.live.values()) remote.hookCame(name);
    }
  }

  /** Stops a plugin and forgets it. */
  uninstall(id: string): void {
    this.stop(id);
    if (!this.installed.delete(id)) return;
    this.defineHooks(id, {});
    this.withdrawServices(id);
    record({ kind: "lifecycle", name: "plugin:uninstall", plugin: id });
    this.onChange?.("uninstall", id);
  }

  /**
   * Plugins about to be installed together (an app's links, the data folder's plugins): the services they provide
   * count as there while they start, so one beside them that needs a service isn't refused for starting first.
   * Call the function it returns once they have.
   */
  expect(sources: string[]): () => void {
    const names = sources.flatMap((source) => {
      try {
        return Object.keys(readManifest(source).provides ?? {});
      } catch {
        return [];
      }
    });
    for (const name of names) this.expected.set(name, (this.expected.get(name) ?? 0) + 1);
    return () => {
      for (const name of names) {
        const left = (this.expected.get(name) ?? 1) - 1;
        if (left > 0) this.expected.set(name, left);
        else this.expected.delete(name);
      }
    };
  }

  /** Puts the services a plugin's manifest provides into the kernel's table, in place of any it provided before. */
  private provideServices(manifest: Manifest): void {
    this.withdrawServices(manifest.id);
    const listening = (hook: string) => ((this.root.events._hooks as Record<string, unknown[]>)[hook]?.length ?? 0) > 0;
    for (const [name, spec] of Object.entries(manifest.provides ?? {})) {
      this.services[name] = providedService(this.root, manifest, name, spec, listening);
      this.providers.set(name, manifest.id);
      record({ kind: "lifecycle", name: "service:provided", plugin: manifest.id, detail: name });
    }
  }

  private withdrawServices(id: string): void {
    for (const [name, by] of [...this.providers]) {
      if (by !== id) continue;
      this.providers.delete(name);
      delete this.services[name];
    }
  }

  /** Turns a plugin on (starting its instances) or off (stopping them). */
  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const plugin = this.installed.get(id);
    if (!plugin || plugin.enabled === enabled) return false;
    plugin.enabled = enabled;
    record({ kind: "lifecycle", name: enabled ? "plugin:enable" : "plugin:disable", plugin: id });
    this.onChange?.(enabled ? "enable" : "disable", id);
    if (!enabled) {
      this.stop(id);
      return true;
    }
    return this.start(id);
  }

  /** Every running instance of a plugin. */
  instances(id: string): string[] {
    return [...this.live.values()].filter((remote) => remote.plugin.id === id).map((remote) => remote.instance);
  }

  async reload(id: string): Promise<boolean> {
    this.stop(id);
    return this.start(id);
  }

  /** A tab opened: start its instances of tab-scoped plugins. */
  hostJoined(host: Host): void {
    if (!this.hosts.workerHosts.includes(host)) return;
    for (const plugin of this.installed.values()) {
      if (plugin.enabled && this.perTab(plugin) && this.runsHere(plugin) && this.allowedIn(plugin, host)) void this.startInstance(plugin, `${plugin.id}@${host.tab}`, host);
    }
  }

  /** A tab's app now links a running tab-scoped plugin: start that tab's instance, if it hasn't one. */
  startIn(id: string, host: Host): void {
    const plugin = this.installed.get(id);
    if (!plugin?.enabled || !this.perTab(plugin) || !this.runsHere(plugin) || !this.allowedIn(plugin, host)) return;
    if (!this.hosts.workerHosts.includes(host)) return;
    const instance = `${id}@${host.tab}`;
    if (this.live.has(instance) || this.waiting.has(instance)) return;
    void this.startInstance(plugin, instance, host);
  }

  /** A tab's app no longer links a tab-scoped plugin: stop that tab's instance. */
  stopIn(id: string, tab: string): void {
    this.stopInstance(`${id}@${tab}`);
  }

  /** A tab closed: its workers went with it. */
  hostLeft(host: Host): void {
    for (const [instance, remote] of this.live) if (remote.host === host) this.stopInstance(instance, false);
  }

  /** The spawner tab changed: start the shared plugins again in the new one. */
  spawnerChanged(host: Host): void {
    for (const plugin of this.installed.values()) {
      if (!plugin.enabled || this.perTab(plugin) || !this.runsHere(plugin)) continue;
      if (this.live.get(plugin.id)?.host === host) continue;
      this.stopInstance(plugin.id, false);
      void this.startInstance(plugin, plugin.id, host);
    }
  }

  deliver(instance: string, message: KernelToPlugin, transfer: Transferable[] = []): void {
    this.live.get(instance)?.post(message, transfer);
  }
}

/**
 * Checks a plugin's view before it reaches a tab and marks each HTML view
 * with whether its plugin may load remote images. The mark is the kernel's,
 * so a plugin can't set it for itself.
 */
function stamp(view: View, remote: boolean, base: string | undefined, depth = 0): View {
  if (!view || typeof view !== "object" || depth > 64) throw new Error("A view must be an object, nested at most 64 deep");
  if (view.type === "html") {
    if (typeof view.html !== "string") throw new Error("An html view needs html");
    if (view.html.length > HTML_MAX) throw new Error(`An html view is limited to ${HTML_MAX} characters`);
    return { type: "html", html: view.html, remote };
  }
  if (view.type === "template") return template(view, remote, base);
  if (view.type === "stack") return { ...view, children: (Array.isArray(view.children) ? view.children : []).map((child) => stamp(child, remote, base, depth + 1)) };
  return view;
}

/**
 * A template view names an .html file relative to the plugin's own URL. The
 * kernel makes it absolute, and only allows a file from the same place the
 * plugin came from, so a plugin can't make the host fetch anything else.
 */
function template(view: Extract<View, { type: "template" }>, remote: boolean, base: string | undefined): View {
  if (!base) throw new Error("Only a plugin an app links has template files; use ctx.ui.html instead");
  if (typeof view.src !== "string" || typeof view.id !== "string" || !/^[\w-]{1,64}$/.test(view.id)) throw new Error("A template view needs a file and an id of letters, digits, - and _");
  const from = new URL(base);
  const src = new URL(view.src, from);
  if (src.origin !== from.origin || !src.pathname.endsWith(".html") || src.search || src.hash) throw new Error(`${view.src} isn't an .html file on the plugin's own site`);
  const data = view.data === undefined ? undefined : JSON.parse(JSON.stringify(view.data));
  if (JSON.stringify(data ?? null).length > HTML_MAX) throw new Error(`A template's data is limited to ${HTML_MAX} characters`);
  return { type: "template", src: src.href, id: view.id, data, remote };
}

export class Remote {
  private ctx: any;
  private fiber: any;
  private listeners = new Map<number, { name: string; off: () => void }>();
  /** Listeners waiting for a plugin's hook that isn't defined yet: its plugin isn't installed. */
  private ahead = new Map<number, string>();
  private pending = new Map<number, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  private disposed = false;
  private markReady!: () => void;
  /** Messages other than `ready` wait for the plugin's Cordis context to exist. */
  private ready = new Promise<void>((resolve) => (this.markReady = resolve));

  constructor(
    readonly instance: string,
    readonly plugin: Installed,
    readonly host: Host,
    private port: MessagePort,
    private manager: RemotePlugins,
  ) {
    port.onmessage = (e: MessageEvent<PluginToKernel>) => void this.receive(e.data);
    port.start();
  }

  /** The hooks this instance listens to, each once, with the ones it waits for. */
  get heard(): string[] {
    return [...new Set([...[...this.listeners.values()].map((l) => l.name), ...this.ahead.values()])];
  }

  /** A plugin's hook was defined: listeners waiting for it start hearing it. */
  hookCame(name: string): void {
    if (!this.ctx) return;
    for (const [listener, waiting] of this.ahead) {
      if (waiting !== name) continue;
      this.ahead.delete(listener);
      this.listen(listener, name);
    }
  }

  /** A plugin's hook went with its plugin: its listeners wait for it to come back. */
  hookGone(name: string): void {
    for (const [listener, l] of this.listeners) {
      if (l.name !== name) continue;
      l.off();
      this.listeners.delete(listener);
      this.ahead.set(listener, name);
    }
  }

  /** The tab this instance belongs to, for tab-scoped plugins. */
  get tab(): string | undefined {
    return this.plugin.manifest.scope === "tab" && this.manager.hosts.mode !== "server" ? this.host.tab : undefined;
  }

  private get caps() {
    return this.plugin.caps;
  }

  post(message: KernelToPlugin, transfer: Transferable[] = []): void {
    if (!this.disposed) this.port.postMessage(message, transfer);
  }

  private async receive(message: PluginToKernel): Promise<void> {
    if (message.t !== "ready" && message.t !== "failed") await this.ready;
    if (this.disposed) return;
    switch (message.t) {
      case "ready": {
        if (JSON.stringify(message.manifest) !== JSON.stringify(this.plugin.manifest)) {
          record({ kind: "error", name: "plugin:manifest-changed", plugin: this.instance, detail: "the manifest it reported differs from its source" });
          this.manager.settle(this.instance, false);
          this.manager.uninstall(this.plugin.id);
          return;
        }
        // A Cordis plugin per instance: every listener lives on its context.
        this.fiber = this.manager.root.plugin({
          name: `remote:${this.instance}`,
          apply: (ctx: any) => {
            // Return nothing: Cordis awaits a returned value, and a Context looks thenable.
            this.ctx = ctx;
          },
        });
        await this.fiber;
        this.markReady();
        record({ kind: "lifecycle", name: "plugin:ready", plugin: this.instance, detail: `in tab ${this.host.tab}` });
        this.manager.settle(this.instance, true);
        return;
      }
      case "failed":
        record({ kind: "error", name: "plugin:failed", plugin: this.instance, detail: message.error });
        this.manager.settle(this.instance, false);
        return;
      case "on":
        return this.listen(message.listener, message.name);
      case "off": {
        this.ahead.delete(message.listener);
        const name = this.listeners.get(message.listener)?.name;
        this.listeners.get(message.listener)?.off();
        this.listeners.delete(message.listener);
        if (name?.startsWith("route:")) this.manager.onRoutes?.();
        return;
      }
      case "hook:result": {
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(message.id);
        waiting.resolve(message.ok ? message.value : { failed: message.error });
        return;
      }
      case "render":
        if (!check(this.instance, this.caps, "ui")) return;
        let view: View | null;
        try {
          view = message.view && stamp(message.view, this.caps.has("network"), this.plugin.href);
        } catch (error) {
          record({ kind: "error", name: "ui:refused", plugin: this.instance, trace: message.trace, detail: String(error instanceof Error ? error.message : error) });
          return;
        }
        this.manager.hosts.render(this.instance, message.slot as Slot, `${this.instance}:${message.key}`, view, message.order ?? this.plugin.manifest.order, this.tab);
        return;
      case "call":
        return this.call(message.id, message.service, message.method, message.args, message.trace);
      case "log":
        record({ kind: message.level === "error" ? "error" : "note", name: "plugin:log", plugin: this.instance, trace: message.trace, detail: message.text });
        return;
    }
  }

  private listen(listener: number, name: string): void {
    const command = /^command:([a-z][a-z0-9-]{0,63})$/.exec(name);
    if (command) return this.command(listener, command[1]);
    const job = /^schedule:([a-z][a-z0-9-]{0,63})$/.exec(name);
    if (job) return this.job(listener, job[1]);
    const provided = /^service:([a-z][a-z0-9-]{0,63})$/.exec(name);
    if (provided) return this.serve(listener, provided[1]);
    const route = /^route:(GET|HEAD|POST|PUT|PATCH|DELETE) (\S+)$/.exec(name);
    if (route) return this.route(listener, route[1], route[2]);
    // A collection's change hook is made when its owner first runs. A reader may listen
    // before that (the contacts app hasn't been opened yet), and hears changes once it exists.
    const spec = hooks.get(name) ?? (name.startsWith("data:changed:") ? ({ mode: "emit" } as HookSpec) : name.startsWith("data:beforeWrite:") ? BEFORE_WRITE : undefined);
    // A plugin's hook (`<plugin>:<key>`) whose plugin isn't installed yet: wait for it, if this plugin may hear it.
    const own = /^([a-z][a-z0-9-]{0,63}):[a-z][a-z0-9-]{0,40}$/.exec(name);
    if (!spec && own && !kernelPrefix(own[1])) {
      if (!grants(this.caps, `hook:listen:${name}`) && !grants(this.caps, `hook:intercept:${name}`)) {
        check(this.instance, this.caps, `hook:listen:${name}`); // traced as denied
        this.post({ t: "event", action: "kernel:denied", value: `hook:listen:${name}` });
        return;
      }
      this.ahead.set(listener, name);
      record({ kind: "lifecycle", name: "hook:ahead", plugin: this.instance, detail: `${name}, until ${own[1]} is installed` });
      return;
    }
    if (!spec) {
      record({ kind: "error", name: "hook:unknown", plugin: this.instance, detail: name });
      this.post({ t: "event", action: "kernel:error", value: `No hook named ${name}` });
      return;
    }
    const scoped = /^data:(?:changed|beforeWrite):(.+)$/.exec(name);
    // Ownership comes from the registry: a manifest can declare a collection another plugin already owns.
    const owns = !!scoped && this.manager.collectionOwner?.(scoped[1]) === this.plugin.id;
    if (scoped && !this.manager.readable?.(this.instance, scoped[1])) {
      record({ kind: "denied", name: `data:read:${scoped[1]}`, plugin: this.instance, detail: `listening to ${name}` });
      this.post({ t: "event", action: "kernel:denied", value: `data:read:${scoped[1]}` });
      return;
    }
    // A hook that names its own capability (debug:trace needs debug:read) keeps it; a change hook not made yet needs hook:listen.
    const needs = hooks.has(name) ? capabilityFor(name) : `hook:${spec.mode === "emit" ? "listen" : "intercept"}:${name}`;
    if (!owns && !check(this.instance, this.caps, needs)) {
      this.post({ t: "event", action: "kernel:denied", value: needs });
      return;
    }
    const held = this.agentSpec(name, spec);
    if (!held) return;
    this.listeners.set(listener, { name, off: this.ctx.on(name, this.forwarder(listener, name, held)) });
  }

  /**
   * An agent that checks a hook gets the hook's agentTimeoutMs rather than its
   * timeoutMs, since a model takes seconds, and may ask for what it couldn't
   * check in time to be blocked (`if-unsure: block`). It can't make a closed
   * hook open. A plugin, or a hook that only tells, keeps the hook's spec;
   * undefined if an agent may not check this hook.
   */
  private agentSpec(name: string, spec: HookSpec): HookSpec | undefined {
    const agent = made.get(this.plugin.source);
    if (!agent) return spec;
    if (spec.mode === "emit" || spec.mode === "parallel") {
      if (!agent.checks.includes(name)) return spec;
      // A hook that only tells can't be stopped: a check of it would answer to no one.
      record({ kind: "error", name: "hook:agent-refused", plugin: this.instance, detail: `${name} only tells that something happened, so it can't be checked; wake on it with \`- hook:\`` });
      this.post({ t: "event", action: "kernel:error", value: `${name} can't be checked` });
      return undefined;
    }
    if (!spec.agentTimeoutMs) {
      record({ kind: "error", name: "hook:agent-refused", plugin: this.instance, detail: `${name} gives agents no time to answer, so an agent can't check it` });
      this.post({ t: "event", action: "kernel:error", value: `${name} can't be checked by an agent` });
      return undefined;
    }
    return { ...spec, timeoutMs: spec.agentTimeoutMs, onFailure: spec.onFailure === "closed" || agent.ifUnsure === "block" ? "closed" : "open" };
  }

  /**
   * A route: requests for a path inside the plugin's own folder, which the
   * service worker sends here (sw/routes/plugins.js). `path` is relative to
   * the plugin's file. Each route is a bail hook named for its method and
   * absolute path, so the kernel answers a request with one dispatch.
   */
  private route(listener: number, method: string, path: string): void {
    const refuse = (why: string) => {
      record({ kind: "error", name: "route:refused", plugin: this.instance, detail: why });
      this.post({ t: "event", action: "kernel:error", value: why });
    };
    if (!check(this.instance, this.caps, "routes")) return void this.post({ t: "event", action: "kernel:denied", value: "routes" });
    const base = this.plugin.href;
    if (!base) return refuse("Only a plugin an app links can add routes");
    const folder = new URL("./", base);
    // The service worker only sees this site's paths, so a plugin from another site has no folder here to answer for.
    if (folder.origin !== env().origin) return refuse("Only a plugin on this site can add routes");
    const at = new URL(path, base);
    if (at.origin !== folder.origin || !at.pathname.startsWith(folder.pathname) || at.pathname === folder.pathname || at.search || at.hash) return refuse(`${path} isn't a path inside the plugin's own folder, ${folder.pathname}`);
    const name = `route:${method} ${at.pathname}`;
    const spec: HookSpec = { mode: "bail", timeoutMs: 10_000, onFailure: "open" };
    this.listeners.set(listener, { name, off: this.ctx.on(name, this.forwarder(listener, name, spec)) });
    this.manager.onRoutes?.();
  }

  /**
   * A command the plugin answers, from ctx.commands.add (services/commands.ts
   * keeps its title and keys). The hook is named after this instance, so no
   * other plugin can answer for it, and a tab's own instance answers a run
   * from that tab.
   */
  private command(listener: number, id: string): void {
    const name = commandHook(this.instance, id);
    // Closed: a command that throws or doesn't answer in time is an error for whoever ran it, not a silent pass.
    const spec: HookSpec = { mode: "bail", timeoutMs: 120_000, onFailure: "closed" };
    this.listeners.set(listener, { name, off: this.ctx.on(name, this.forwarder(listener, name, spec)) });
  }

  /** A service the plugin provides (provided.ts): its calls come on a hook named after it, so no other can answer. */
  private serve(listener: number, service: string): void {
    if (!this.plugin.manifest.provides?.[service] || !check(this.instance, this.caps, `provide:${service}`)) {
      return void this.post({ t: "event", action: "kernel:denied", value: `provide:${service}` });
    }
    const name = serviceHook(this.plugin.id, service);
    // Closed: a provider that throws or doesn't answer in time is an error for the caller, not a silent pass.
    const spec: HookSpec = { mode: "bail", timeoutMs: SERVICE_TIMEOUT_MS, onFailure: "closed" };
    this.listeners.set(listener, { name, off: this.ctx.on(name, this.forwarder(listener, name, spec)) });
  }

  /** A job the plugin set with ctx.schedule (services/schedule.ts): named after the plugin, so no other can answer it. */
  private job(listener: number, id: string): void {
    if (!check(this.instance, this.caps, "schedule")) return void this.post({ t: "event", action: "kernel:denied", value: "schedule" });
    const name = scheduleHook(this.plugin.id, id);
    const spec: HookSpec = { mode: "bail", timeoutMs: 60_000, onFailure: "open" };
    this.listeners.set(listener, { name, off: this.ctx.on(name, this.forwarder(listener, name, spec)) });
  }

  private forwarder(listener: number, name: string, spec: HookSpec) {
    const remote = this;
    if (spec.mode === "emit" || spec.mode === "parallel") {
      return function (this: Dispatch | null, ...args: unknown[]) {
        remote.post({ t: "hook", listener, name, args, trace: this?.trace });
      };
    }
    if (spec.mode === "waterfall") {
      return async function (this: Dispatch | null, ...args: unknown[]) {
        const next = args.pop() as () => unknown;
        const result = (await remote.ask(listener, name, args, spec, this?.trace)) as Record<string, unknown> | undefined;
        if (result && "block" in result) return result;
        if (result && typeof result === "object" && args[0] && typeof args[0] === "object") Object.assign(args[0], result);
        return next();
      };
    }
    return function (this: Dispatch | null, ...args: unknown[]) {
      return remote.ask(listener, name, args, spec, this?.trace);
    };
  }

  private ask(listener: number, name: string, args: unknown[], spec: HookSpec, trace: string | undefined): Promise<unknown> {
    const id = ++this.nextId;
    const started = performance.now();
    const limit = spec.timeoutMs ?? 2000;
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ failed: `timed out after ${limit} ms` });
      }, limit);
      this.pending.set(id, { resolve, timer });
      this.post({ t: "hook", id, listener, name, args, trace });
    }).then((value) => {
      const failed = value && typeof value === "object" && "failed" in value ? String((value as { failed: unknown }).failed) : undefined;
      record({
        kind: "remote",
        name,
        plugin: this.instance,
        ms: ms(started),
        trace,
        detail: failed ? `failed: ${failed}` : value === undefined || value === null ? "passed" : JSON.stringify(value).slice(0, 120),
      });
      if (!failed) return value ?? undefined;
      return spec.onFailure === "closed" ? { block: `${this.instance} could not answer ${name} (${failed})` } : undefined;
    });
  }

  private async call(id: number, service: string, method: string, args: unknown[], trace?: string): Promise<void> {
    const reply = (ok: boolean, value?: unknown, error?: string) => this.post({ t: "result", id, ok, value, error });
    try {
      reply(true, await callService(this.manager.services, this.instance, this.caps, service, method, args, { trace }));
    } catch (error) {
      reply(false, undefined, String(error instanceof Error ? error.message : error));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.manager.onDispose?.(this.instance);
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve({ failed: "plugin stopped" });
    }
    this.pending.clear();
    const routed = this.heard.some((name) => name.startsWith("route:"));
    this.listeners.clear();
    this.ahead.clear();
    if (routed) this.manager.onRoutes?.();
    void this.fiber?.dispose?.();
    this.port.close();
  }
}

/** The hook a plugin instance answers its command `id` on. Only that instance can listen to it. */
export const commandHook = (instance: string, id: string) => `command:${instance} ${id}`;
/** The hook a plugin's scheduled job runs on: its plugin's id (not instance) and the job's name. */
export const scheduleHook = (plugin: string, name: string) => `schedule:${plugin} ${name}`;

/**
 * Calls a service method for a plugin instance, through the gate: the method
 * must be listed, and the plugin must hold the capability it needs. Every
 * plugin call comes through here, and so does every tool call
 * (services/tools.ts), so a tool can never do more than its plugin could.
 */
export async function callService(services: Record<string, ServiceProvider>, instance: string, caps: Set<string>, service: string, method: string, args: unknown[], dispatch: Dispatch): Promise<unknown> {
  // Own entries only: `toString` or `__proto__` would find the object's prototype instead.
  const provider = Object.hasOwn(services, service) ? services[service] : undefined;
  if (!provider) throw new Error(`No service named ${service}`);
  if (!Object.hasOwn(provider.methods, method)) throw new Error(`${service}.${method} is not a method`);
  const needed = provider.capability(method, args);
  if (needed && !check(instance, caps, needed)) throw new Error(`Missing capability ${needed}`);
  const started = performance.now();
  try {
    const value = await provider.call(instance, method, args, dispatch);
    record({ kind: "call", name: `${service}.${method}`, plugin: instance, trace: dispatch.trace, ms: ms(started) });
    return value;
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    record({ kind: "call", name: `${service}.${method}`, plugin: instance, trace: dispatch.trace, ms: ms(started), detail: `failed: ${message}` });
    throw error;
  }
}
