// The open tabs (hosts) connected to this kernel, the views plugins have
// rendered, and the bridges to APIs that only exist in a page.
//
// A shared worker cannot create workers (checked in Chromium 153), so one
// tab, the spawner, creates the sandboxed plugin workers and hands the
// kernel a port to each. When the spawner tab goes away, the next tab takes
// over and the plugins are started again there.

import type { Dispatch, HostToKernel, KernelToHost, Slot, View } from "../shared/protocol";
import { record } from "./trace";

export interface Host {
  tab: string;
  port: MessagePort;
  /** The screen the tab shows, from its address, and when it last changed (see services/router.ts). */
  url?: { path: string; query: Record<string, string>; at: number };
}

type Rendered = { slot: Slot; key: string; owner: string; order: number; view: View | null; tab?: string };

export class Hosts {
  readonly list: Host[] = [];
  private views = new Map<string, Rendered>();
  private bridgeId = 0;
  private bridgeWaiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  onSpawnerChange?: (host: Host | undefined) => void;
  onMessage?: (host: Host, message: HostToKernel) => void;
  onHello?: (host: Host, folder: FileSystemDirectoryHandle | undefined) => void;
  onLeave?: (host: Host) => void;

  constructor(readonly mode: "shared" | "dedicated") {}

  get spawner(): Host | undefined {
    return this.list[0];
  }

  connect(port: MessagePort): void {
    let host: Host | undefined;
    port.onmessage = (e: MessageEvent<HostToKernel>) => {
      const message = e.data;
      if (message.t === "hello") {
        host = { tab: message.tab, port };
        this.list.push(host);
        this.onHello?.(host, message.folder);
        // Each tab holds a Web Lock named after it for as long as it lives;
        // the kernel gets the lock only once the tab has gone. This catches
        // tabs that close without a chance to say goodbye.
        const leaving = host;
        void navigator.locks.request(`ewa-tab-${message.tab}`, () => this.disconnect(leaving));
        const spawner = this.spawner === host;
        this.send(host, { t: "welcome", tab: message.tab, spawner, mode: this.mode });
        for (const { tab, ...view } of this.views.values()) if (!tab || tab === host.tab) this.send(host, { t: "render", ...view });
        record({ kind: "lifecycle", name: "host:connect", detail: `${message.tab}${spawner ? " (spawner)" : ""}` });
        if (spawner) this.onSpawnerChange?.(host);
        return;
      }
      if (!host) return;
      if (message.t === "bye") return this.disconnect(host);
      if (message.t === "bridge:result") {
        const waiting = this.bridgeWaiting.get(message.id);
        this.bridgeWaiting.delete(message.id);
        if (message.ok) waiting?.resolve(message.value);
        else waiting?.reject(new Error(message.error));
        return;
      }
      this.onMessage?.(host, message);
    };
    port.start();
  }

  private disconnect(host: Host): void {
    const index = this.list.indexOf(host);
    if (index < 0) return;
    const wasSpawner = index === 0;
    this.list.splice(index, 1);
    record({ kind: "lifecycle", name: "host:disconnect", detail: host.tab });
    this.onLeave?.(host);
    if (wasSpawner) {
      if (this.spawner) this.send(this.spawner, { t: "welcome", tab: this.spawner.tab, spawner: true, mode: this.mode });
      this.onSpawnerChange?.(this.spawner);
    }
  }

  send(host: Host, message: KernelToHost, transfer: Transferable[] = []): void {
    host.port.postMessage(message, transfer);
  }

  broadcast(message: KernelToHost): void {
    for (const host of this.list) this.send(host, message);
  }

  /** Shows a view in a slot: in every tab, or only in `tab` for a tab-scoped plugin. */
  render(owner: string, slot: Slot, key: string, view: View | null, order = 1000, tab?: string): void {
    const id = `${slot}/${key}`;
    if (view) this.views.set(id, { slot, key, owner, order, view, tab });
    else this.views.delete(id);
    const message: KernelToHost = { t: "render", slot, key, owner, order, view };
    for (const host of this.list) if (!tab || host.tab === tab) this.send(host, message);
  }

  /** Removes every view a plugin rendered (when it unloads). */
  clear(owner: string): void {
    for (const [id, view] of this.views) {
      if (view.owner !== owner) continue;
      this.views.delete(id);
      const message: KernelToHost = { t: "render", slot: view.slot, key: view.key, owner, order: view.order, view: null };
      for (const host of this.list) if (!view.tab || host.tab === view.tab) this.send(host, message);
    }
  }

  /** Calls a page-only API in the spawner tab (audio, worker counts, ...), or in the tab given. */
  bridge(service: string, method: string, args: unknown[], dispatch: Dispatch = {}, to?: Host): Promise<unknown> {
    const host = to ?? this.spawner;
    if (!host) return Promise.reject(new Error("No tab is open"));
    const id = ++this.bridgeId;
    const started = performance.now();
    return new Promise<unknown>((resolve, reject) => {
      this.bridgeWaiting.set(id, { resolve, reject });
      this.send(host, { t: "bridge", id, service, method, args });
    }).finally(() => record({ kind: "bridge", name: `${service}.${method}`, ms: Math.round((performance.now() - started) * 100) / 100, trace: dispatch.trace }));
  }
}
