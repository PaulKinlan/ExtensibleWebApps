// Sandboxed plugins. Each one runs in its own dedicated worker; the kernel
// holds a port to it and a Cordis fiber that owns every listener registered
// on its behalf, so unloading the plugin disposes all of them at once.
//
// Hooks are carried across the port according to their spec: `emit` and
// `parallel` are posted and forgotten; `serial`, `bail` and `waterfall`
// wait for the plugin's answer within the hook's time limit, and apply the
// hook's failure policy when it doesn't come.

import type { KernelToPlugin, Manifest, PluginToKernel, Slot } from "../shared/protocol";
import { capabilities, check } from "./gate";
import { capabilityFor, hooks, type HookSpec } from "./hooks";
import type { Hosts } from "./hosts";
import { currentTrace, record, withTrace } from "./trace";

export interface ServiceProvider {
  /** Capability a plugin needs to call this method. */
  capability(method: string): string | undefined;
  call(plugin: string, method: string, args: unknown[]): Promise<unknown> | unknown;
}

type Waiter = { resolve: (ok: boolean) => void };

export class RemotePlugins {
  readonly sources = new Map<string, string>();
  readonly live = new Map<string, Remote>();
  private waiting = new Map<string, Waiter[]>();

  constructor(
    readonly root: any,
    readonly hosts: Hosts,
    readonly services: Record<string, ServiceProvider>,
  ) {}

  /** Installs (or replaces) a plugin from its source and starts it. Resolves true once it is running. */
  install(id: string, source: string): Promise<boolean> {
    this.stop(id);
    this.sources.set(id, source);
    return this.start(id);
  }

  start(id: string): Promise<boolean> {
    const source = this.sources.get(id);
    const host = this.hosts.spawner;
    if (!source || !host) return Promise.resolve(false);
    record({ kind: "lifecycle", name: "plugin:spawn", plugin: id });
    this.hosts.send(host, { t: "spawn", plugin: id, source });
    return new Promise((resolve) => {
      const waiter: Waiter = { resolve };
      const list = this.waiting.get(id) ?? [];
      list.push(waiter);
      this.waiting.set(id, list);
      setTimeout(() => {
        const current = this.waiting.get(id);
        if (!current?.includes(waiter)) return;
        current.splice(current.indexOf(waiter), 1);
        record({ kind: "error", name: "plugin:start-timeout", plugin: id });
        resolve(false);
      }, 5000);
    });
  }

  /** The spawner tab created the worker and passed its port. */
  attach(id: string, port: MessagePort): void {
    this.live.get(id)?.dispose();
    this.live.set(id, new Remote(id, port, this));
  }

  settle(id: string, ok: boolean): void {
    for (const waiter of this.waiting.get(id) ?? []) waiter.resolve(ok);
    this.waiting.delete(id);
  }

  stop(id: string, terminate = true): void {
    const remote = this.live.get(id);
    if (!remote) return;
    remote.dispose();
    this.live.delete(id);
    this.hosts.clear(id);
    const host = this.hosts.spawner;
    if (terminate && host) this.hosts.send(host, { t: "terminate", plugin: id });
    record({ kind: "lifecycle", name: "plugin:stop", plugin: id });
  }

  async reload(id: string): Promise<boolean> {
    this.stop(id);
    return this.start(id);
  }

  /** The spawner tab went away: its workers are gone, so start every plugin again in the new spawner. */
  respawnAll(): void {
    for (const id of [...this.live.keys()]) this.stop(id, false);
    for (const id of this.sources.keys()) void this.start(id);
  }

  deliver(id: string, message: KernelToPlugin, transfer: Transferable[] = []): void {
    this.live.get(id)?.post(message, transfer);
  }
}

export class Remote {
  manifest?: Manifest;
  private caps = new Set<string>();
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
    readonly id: string,
    private port: MessagePort,
    private manager: RemotePlugins,
  ) {
    port.onmessage = (e: MessageEvent<PluginToKernel>) => void this.receive(e.data);
    port.start();
  }

  post(message: KernelToPlugin, transfer: Transferable[] = []): void {
    if (!this.disposed) this.port.postMessage(message, transfer);
  }

  private async receive(message: PluginToKernel): Promise<void> {
    if (message.t !== "ready" && message.t !== "failed") await this.ready;
    if (this.disposed) return;
    switch (message.t) {
      case "ready": {
        this.manifest = message.manifest;
        this.caps = capabilities(message.manifest);
        // A Cordis plugin per remote plugin: every listener lives on its context.
        this.fiber = this.manager.root.plugin({ name: `remote:${this.id}`, apply: (ctx: any) => {
            // Return nothing: Cordis awaits a returned value, and a Context looks thenable.
            this.ctx = ctx;
          },
        });
        await this.fiber;
        this.markReady();
        record({ kind: "lifecycle", name: "plugin:ready", plugin: this.id, detail: [...this.caps].join(" ") });
        this.manager.settle(this.id, true);
        return;
      }
      case "failed":
        record({ kind: "error", name: "plugin:failed", plugin: this.id, detail: message.error });
        this.manager.settle(this.id, false);
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
        if (!check(this.id, this.caps, "ui")) return;
        this.manager.hosts.render(this.id, message.slot as Slot, `${this.id}:${message.key}`, message.view, message.order ?? this.manifest?.order);
        return;
      case "call":
        return this.call(message.id, message.service, message.method, message.args, message.trace);
      case "log":
        record({ kind: message.level === "error" ? "error" : "note", name: "plugin:log", plugin: this.id, detail: message.text });
        return;
    }
  }

  private listen(listener: number, name: string): void {
    const spec = hooks.get(name);
    if (!spec) {
      record({ kind: "error", name: "hook:unknown", plugin: this.id, detail: name });
      this.post({ t: "event", action: "kernel:error", value: `No hook named ${name}` });
      return;
    }
    if (!check(this.id, this.caps, capabilityFor(name))) {
      this.post({ t: "event", action: "kernel:denied", value: capabilityFor(name) });
      return;
    }
    this.listeners.set(listener, this.ctx.on(name, this.forwarder(listener, name, spec)));
  }

  private forwarder(listener: number, name: string, spec: HookSpec) {
    if (spec.mode === "emit" || spec.mode === "parallel") {
      return (...args: unknown[]) => this.post({ t: "hook", listener, name, args, trace: currentTrace });
    }
    if (spec.mode === "waterfall") {
      return async (...args: unknown[]) => {
        const next = args.pop() as () => unknown;
        const result = (await this.ask(listener, name, args, spec)) as Record<string, unknown> | undefined;
        if (result && "block" in result) return result;
        if (result && typeof result === "object" && args[0] && typeof args[0] === "object") Object.assign(args[0], result);
        return next();
      };
    }
    return (...args: unknown[]) => this.ask(listener, name, args, spec);
  }

  private ask(listener: number, name: string, args: unknown[], spec: HookSpec): Promise<unknown> {
    const id = ++this.nextId;
    const trace = currentTrace;
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
      const ms = Math.round((performance.now() - started) * 100) / 100;
      const failed = value && typeof value === "object" && "failed" in value ? String((value as { failed: unknown }).failed) : undefined;
      withTrace(trace, () =>
        record({ kind: "remote", name, plugin: this.id, ms, detail: failed ? `failed: ${failed}` : value === undefined || value === null ? "passed" : JSON.stringify(value).slice(0, 120) }),
      );
      if (!failed) return value ?? undefined;
      return spec.onFailure === "closed" ? { block: `${this.id} could not answer ${name} (${failed})` } : undefined;
    });
  }

  private async call(id: number, service: string, method: string, args: unknown[], trace?: string): Promise<void> {
    const provider = this.manager.services[service];
    const reply = (ok: boolean, value?: unknown, error?: string) => this.post({ t: "result", id, ok, value, error });
    if (!provider) return reply(false, undefined, `No service named ${service}`);
    const needed = provider.capability(method);
    if (needed && !check(this.id, this.caps, needed)) return reply(false, undefined, `Missing capability ${needed}`);
    try {
      reply(true, await withTrace(trace, () => provider.call(this.id, method, args)));
    } catch (error) {
      reply(false, undefined, String(error instanceof Error ? error.message : error));
    }
  }

  /** Counts listeners this plugin holds in the kernel (for the leak test). */
  get listenerCount(): number {
    return this.listeners.size;
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
