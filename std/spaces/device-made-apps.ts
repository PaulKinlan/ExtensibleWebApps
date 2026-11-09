// The device's side of the apps members made and shared (made-apps.ts says how it works): asks
// the space for them, and shares one, for the maker module through the space seam. Loaded only in
// a kernel for a space (on-device.ts).

import type { AppRequest, SyncToDevice } from "../../src/shared/sync";
import type { MadeAppsSeam } from "../../src/kernel/modules";

/** What a device's sync (device.ts) gives this: its socket, and what it hears on it. */
interface DeviceSocket {
  send(message: AppRequest): boolean;
  heard: Set<(message: SyncToDevice) => void>;
  caughtUp: Set<() => void>;
}

/**
 * A device's side, lent to the maker module through the space seam (MadeAppsSeam): asks the space for its
 * shared apps, shares one, and hears when the list changes. `names` gives members' names by id.
 */
export function deviceMadeApps(socket: DeviceSocket, names: () => Promise<Record<string, string>>): MadeAppsSeam & { stop(): void } {
  const waiting = new Map<number, (reply: Extract<SyncToDevice, { op: "apps:reply" }> | undefined) => void>();
  let asked = 0;
  type Ask = AppRequest extends infer R ? (R extends AppRequest ? Omit<R, "t" | "op" | "id"> : never) : never;
  function ask(request: Ask): Promise<Extract<SyncToDevice, { op: "apps:reply" }> | undefined> {
    const id = ++asked;
    return new Promise((done) => {
      if (!socket.send({ t: "sync", op: "apps", id, ...request } as AppRequest)) return done(undefined);
      waiting.set(id, done);
      setTimeout(() => {
        if (waiting.delete(id)) done(undefined);
      }, 20_000);
    });
  }
  const changed = new Set<() => void>();
  const tellChanged = () => {
    for (const then of changed) then();
  };
  const heard = (message: SyncToDevice) => {
    if (message.op === "apps:reply") {
      const done = waiting.get(message.id);
      waiting.delete(message.id);
      done?.(message);
    } else if (message.op === "apps:changed") tellChanged();
  };
  socket.heard.add(heard);
  socket.caughtUp.add(tellChanged);
  const offline = "The space can't be reached just now: try again once this device is back online";

  return {
    changed,
    async list() {
      const reply = await ask({ action: "list" });
      if (!reply) return undefined;
      if (!reply.ok || !reply.list) return [];
      const who = await names().catch(() => ({}) as Record<string, string>);
      return reply.list.map((a) => ({ ...a, ...(a.by ? { byName: who[a.by] ?? a.by } : {}) }));
    },
    async get(name) {
      const reply = await ask({ action: "get", name });
      if (!reply) return { ok: false, error: offline };
      return reply.ok && reply.files && reply.hash ? { ok: true, files: reply.files, hash: reply.hash } : { ok: false, error: reply.error ?? "The space has no such app" };
    },
    async share(name, files) {
      const reply = await ask({ action: "share", name, files });
      if (!reply) return { ok: false, error: offline };
      return reply.ok && reply.hash ? { ok: true, hash: reply.hash } : { ok: false, error: reply.error ?? "The space didn't take it" };
    },
    async unshare(name) {
      const reply = await ask({ action: "unshare", name });
      if (!reply) return { ok: false, error: offline };
      return reply.ok ? { ok: true } : { ok: false, error: reply.error ?? "The space didn't take it" };
    },
    stop() {
      socket.heard.delete(heard);
      socket.caughtUp.delete(tellChanged);
      changed.clear();
    },
  };
}
