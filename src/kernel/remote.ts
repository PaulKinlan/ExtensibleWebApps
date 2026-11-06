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

import type { Dispatch, KernelToPlugin, Manifest, PluginToKernel, Slot } from "../shared/protocol";
import { capabilities, check } from "./gate";
import { capabilityFor, hooks, type HookSpec } from "./hooks";
import type { Host, Hosts } from "./hosts";
import { ManifestError, readManifest } from "./manifest";
import { record } from "./trace";

export interface ServiceProvider {
  /** Capability a plugin needs to call this method. */
  capability(method: string): string | undefined;
  call(plugin: string, method: string, args: unknown[], dispatch: Dispatch): Promise<unknown> | unknown;
}

/** Where a plugin came from: bundled with the app, or kept in the data folder. */
export type Origin = "built-in" | "data";

export interface Installed {
  id: string;
  source: string;
  manifest: Manifest;
  caps: Set<string>;
  origin: Origin;
  /** A plugin that is turned off stays installed but runs no instances. */
  enabled: boolean;
}

export type InstallResult = { ok: true; id: string; started: boolean } | { ok: false; error: string };

type Waiter = { resolve: (ok: boolean) => void };

const ms = (since: number) => Math.round((performance.now() - since) * 100) / 100;

export class RemotePlugins {
  readonly installed = new Map<string, Installed>();
  readonly live = new Map<string, Remote>();
  private waiting = new Map<string, Waiter[]>();
  /** Told when plugins are installed, removed, or turned on or off. */
  onChange?: (change: "install" | "uninstall" | "enable" | "disable", id: string) => void;

  constructor(
    readonly root: any,
    readonly hosts: Hosts,
    readonly services: Record<string, ServiceProvider>,
  ) {}

  /** Installs (or replaces) a plugin from its source and starts it. The manifest is read without running the code. */
  async install(source: string, options: { origin?: Origin; enabled?: boolean } = {}): Promise<InstallResult> {
    let manifest: Manifest;
    try {
      manifest = readManifest(source);
    } catch (error) {
      const message = error instanceof ManifestError ? error.message : String(error);
      record({ kind: "error", name: "plugin:refused", detail: message });
      return { ok: false, error: message };
    }
    const previous = this.installed.get(manifest.id);
    this.stop(manifest.id);
    const enabled = options.enabled ?? previous?.enabled ?? true;
    this.installed.set(manifest.id, { id: manifest.id, source, manifest, caps: capabilities(manifest), origin: options.origin ?? "data", enabled });
    record({ kind: "lifecycle", name: "plugin:install", plugin: manifest.id, detail: `${manifest.scope ?? "shared"}: ${manifest.permissions.join(" ")}${enabled ? "" : " (off)"}` });
    this.onChange?.("install", manifest.id);
    return { ok: true, id: manifest.id, started: enabled && (await this.start(manifest.id)) };
  }

  /** Starts every instance a plugin needs. Resolves true when all of them are running. */
  async start(id: string): Promise<boolean> {
    const plugin = this.installed.get(id);
    if (!plugin?.enabled) return false;
    const targets = this.targets(plugin);
    const started = await Promise.all(targets.map(([instance, host]) => this.startInstance(plugin, instance, host)));
    return started.length > 0 && started.every(Boolean);
  }

  private targets(plugin: Installed): [string, Host][] {
    if (plugin.manifest.scope === "tab") return this.hosts.list.map((host) => [`${plugin.id}@${host.tab}`, host]);
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

  /** Stops a plugin and forgets it. */
  uninstall(id: string): void {
    this.stop(id);
    if (!this.installed.delete(id)) return;
    record({ kind: "lifecycle", name: "plugin:uninstall", plugin: id });
    this.onChange?.("uninstall", id);
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
    for (const plugin of this.installed.values()) {
      if (plugin.enabled && plugin.manifest.scope === "tab") void this.startInstance(plugin, `${plugin.id}@${host.tab}`, host);
    }
  }

  /** A tab closed: its workers went with it. */
  hostLeft(host: Host): void {
    for (const [instance, remote] of this.live) if (remote.host === host) this.stopInstance(instance, false);
  }

  /** The spawner tab changed: start the shared plugins again in the new one. */
  spawnerChanged(host: Host): void {
    for (const plugin of this.installed.values()) {
      if (!plugin.enabled || plugin.manifest.scope === "tab") continue;
      if (this.live.get(plugin.id)?.host === host) continue;
      this.stopInstance(plugin.id, false);
      void this.startInstance(plugin, plugin.id, host);
    }
  }

  deliver(instance: string, message: KernelToPlugin, transfer: Transferable[] = []): void {
    this.live.get(instance)?.post(message, transfer);
  }
}

export class Remote {
  private ctx: any;
  private fiber: any;
  private listeners = new Map<number, () => void>();
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

  /** The tab this instance belongs to, for tab-scoped plugins. */
  get tab(): string | undefined {
    return this.plugin.manifest.scope === "tab" ? this.host.tab : undefined;
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
      case "off":
        this.listeners.get(message.listener)?.();
        this.listeners.delete(message.listener);
        return;
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
        this.manager.hosts.render(this.instance, message.slot as Slot, `${this.instance}:${message.key}`, message.view, message.order ?? this.plugin.manifest.order, this.tab);
        return;
      case "call":
        return this.call(message.id, message.service, message.method, message.args, message.trace);
      case "log":
        record({ kind: message.level === "error" ? "error" : "note", name: "plugin:log", plugin: this.instance, trace: message.trace, detail: message.text });
        return;
    }
  }

  private listen(listener: number, name: string): void {
    const spec = hooks.get(name);
    if (!spec) {
      record({ kind: "error", name: "hook:unknown", plugin: this.instance, detail: name });
      this.post({ t: "event", action: "kernel:error", value: `No hook named ${name}` });
      return;
    }
    if (!check(this.instance, this.caps, capabilityFor(name))) {
      this.post({ t: "event", action: "kernel:denied", value: capabilityFor(name) });
      return;
    }
    this.listeners.set(listener, this.ctx.on(name, this.forwarder(listener, name, spec)));
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
    const provider = this.manager.services[service];
    const reply = (ok: boolean, value?: unknown, error?: string) => this.post({ t: "result", id, ok, value, error });
    if (!provider) return reply(false, undefined, `No service named ${service}`);
    const needed = provider.capability(method);
    if (needed && !check(this.instance, this.caps, needed)) return reply(false, undefined, `Missing capability ${needed}`);
    const started = performance.now();
    try {
      reply(true, await provider.call(this.instance, method, args, { trace }));
      record({ kind: "call", name: `${service}.${method}`, plugin: this.instance, trace, ms: ms(started) });
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      reply(false, undefined, message);
      record({ kind: "call", name: `${service}.${method}`, plugin: this.instance, trace, ms: ms(started), detail: `failed: ${message}` });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve({ failed: "plugin stopped" });
    }
    this.pending.clear();
    this.listeners.clear();
    void this.fiber?.dispose?.();
    this.port.close();
  }
}
