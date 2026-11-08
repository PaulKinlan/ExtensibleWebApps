// Members' plugins in a space: a plugin a member adds to an app in a space
// (Customize, at /s/<space>/…) goes to every member's browser. It never runs
// on the space's server, which runs only the plugins an app's app.html links
// (server-apps.ts); the space only keeps its files and hands them out.
//
// Each device decides for itself whether to run it. A plugin someone else
// shared arrives turned off, as any plugin added to an app does, and the
// person turns it on in Customize after seeing what it asks for. When
// someone changes a plugin, it arrives off again. Removing a shared plugin
// removes it from the space, and from every member's device.
//
// The space's side keeps the plugins in its own `user/<app>/` folder, and a
// list of them, with who shared each, in `user/shared.json`. A device keeps
// what it has from the space, and what it hasn't sent yet, in
// `sync/plugins.json`. Both folders belong to the platform (paths.ts), so a
// plugin can't write a plugin into them.
//
// They speak over the sync socket (src/shared/sync.ts): a device asks for the
// list when it has caught up, and again whenever the space says a member
// changed it, then fetches each plugin it hasn't got, one message each.

import type { PluginRequest, SharedFile, SharedSummary, SyncToDevice } from "../shared/sync";
import type { Host, Hosts } from "./hosts";
import { readManifest } from "./manifest";
import type { Store } from "./store";
import { record as trace } from "./trace";
import { checkApp, type UserPlugins } from "./user-plugins";

const INDEX = "user/shared.json";
const STATE = "sync/plugins.json";
/** A shared plugin and its files, as sent: one WebSocket message, which Cloudflare caps at 1 MiB. */
const MAX_BYTES = 700_000;
const MAX_PLUGINS = 200;
const TEXT = /\.(js|mjs|html|css|json|svg|txt|md)$/i;
const ID = /^[\w-]{1,64}$/;

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const sizeOf = (files: SharedFile[]) => files.reduce((n, f) => n + f.name.length + ("text" in f ? f.text.length : f.base64.length), 0);

/** A plugin's files as they are kept for an app: the plugin, and each file its manifest lists. */
async function filesOf(store: Store, userAdded: UserPlugins, app: string, id: string): Promise<SharedFile[] | undefined> {
  const plugin = (await userAdded.list(app)).find((p) => p.id === id);
  if (!plugin) return undefined;
  const source = await store.readText(`user/${app}/${plugin.file}`);
  if (source === undefined) return undefined;
  const out: SharedFile[] = [{ name: plugin.file, text: source }];
  for (const name of readManifest(source).files ?? []) {
    if (TEXT.test(name)) {
      const text = await store.readText(`user/${app}/${name}`);
      if (text !== undefined) out.push({ name, text });
    } else {
      const bytes = await store.readBytes(`user/${app}/${name}`);
      if (bytes) out.push({ name, base64: toBase64(bytes) });
    }
  }
  return out;
}

/** The files, as `user:add` takes them. */
function decode(files: SharedFile[]): { name: string; data: Blob | string }[] {
  return files.map((f) => ({ name: f.name, data: "text" in f ? f.text : new Blob([fromBase64(f.base64)]) }));
}

async function hashOf(files: SharedFile[]): Promise<string> {
  const text = JSON.stringify([...files].sort((a, b) => a.name.localeCompare(b.name)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Whether `files` is a list of files a device may send: names and contents, text or base64. */
function wellFormed(files: unknown): files is SharedFile[] {
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.length <= 21 &&
    files.every((f) => f && typeof f === "object" && typeof f.name === "string" && (typeof f.text === "string" || typeof f.base64 === "string"))
  );
}

/** The space's side: keeps the plugins members share, and tells every device when they change. */
export function spacePlugins(userAdded: UserPlugins, store: Store, hosts: Hosts, tell: (message: SyncToDevice) => void) {
  let index: Record<string, Record<string, { hash: string; by?: string; at: string }>> = Object.create(null);
  const loaded = store.readJson<unknown>(INDEX, {}).then((saved) => {
    if (saved && typeof saved === "object" && !Array.isArray(saved)) index = Object.assign(Object.create(null), saved);
  });
  /** One change at a time, so the list and the folder agree. */
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };
  const count = () => Object.values(index).reduce((n, plugins) => n + Object.keys(plugins).length, 0);

  async function answer(host: Host, m: PluginRequest): Promise<Omit<Extract<SyncToDevice, { op: "plugins:reply" }>, "t" | "op" | "id">> {
    await loaded;
    if (m.action === "list") {
      const list: SharedSummary[] = Object.entries(index).flatMap(([app, plugins]) => Object.entries(plugins).map(([id, p]) => ({ app, id, ...p })));
      return { ok: true, list };
    }
    const app = checkApp(m.app);
    if (m.action === "get") {
      if (!index[app]?.[m.plugin]) return { ok: false, error: "The space has no such plugin" };
      const files = await filesOf(store, userAdded, app, m.plugin);
      return files ? { ok: true, files } : { ok: false, error: "The space has no such plugin" };
    }
    if (m.action === "remove") {
      if (typeof m.plugin !== "string" || !ID.test(m.plugin)) return { ok: false, error: "That isn't a plugin's id" };
      return serially(async () => {
        await userAdded.remove(app, m.plugin, { quiet: true });
        const had = !!index[app]?.[m.plugin];
        if (index[app]) delete index[app][m.plugin];
        if (index[app] && !Object.keys(index[app]).length) delete index[app];
        await store.writeJson(INDEX, index);
        if (had) tell({ t: "sync", op: "plugins:changed" });
        trace({ kind: "lifecycle", name: "shared-plugin:remove", plugin: m.plugin, detail: `${app}${host.member ? `, by ${host.member}` : ""}` });
        return { ok: true };
      });
    }
    if (m.action === "add") {
      if (!wellFormed(m.files)) return { ok: false, error: "A shared plugin is between 1 and 21 files" };
      if (sizeOf(m.files) > MAX_BYTES) return { ok: false, error: "A shared plugin and its files are 700 KB at most" };
      if (m.files.filter((f) => f.name.endsWith(".js")).length !== 1) return { ok: false, error: "Share one plugin (.js) at a time" };
      return serially(async () => {
        const added = await userAdded.add(app, decode(m.files), { quiet: true });
        if (!added.ok) return { ok: false, error: added.error };
        const id = added.ids[0];
        if (!index[app]?.[id] && count() >= MAX_PLUGINS) {
          await userAdded.remove(app, id, { quiet: true });
          return { ok: false, error: `A space keeps ${MAX_PLUGINS} plugins at most` };
        }
        const files = (await filesOf(store, userAdded, app, id)) ?? [];
        const hash = await hashOf(files);
        (index[app] ??= Object.create(null))[id] = { hash, ...(host.member ? { by: host.member } : {}), at: new Date().toISOString() };
        await store.writeJson(INDEX, index);
        tell({ t: "sync", op: "plugins:changed" });
        trace({ kind: "lifecycle", name: "shared-plugin:add", plugin: id, detail: `${app}${host.member ? `, by ${host.member}` : ""}` });
        return { ok: true, hash };
      });
    }
    return { ok: false, error: "Not something the space does with plugins" };
  }

  return {
    /** A device's request: answered on its socket, with the request's id. */
    async handle(host: Host, m: PluginRequest): Promise<void> {
      const reply = await answer(host, m).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      hosts.send(host, { t: "sync", op: "plugins:reply", id: m.id, ...reply });
    },
  };
}

/** What a device's sync (sync-device.ts) gives this: its socket, and what it hears on it. */
interface DeviceSocket {
  send(message: PluginRequest): boolean;
  heard: Set<(message: SyncToDevice) => void>;
  caughtUp: Set<() => void>;
}

/**
 * A device's side: sends the plugins the person adds or removes here to the space, and puts the ones
 * other members share in this device's copy, turned off. `reopen` starts an app's plugins again, when a
 * plugin that was on here changes or goes.
 */
export function devicePlugins(userAdded: UserPlugins, store: Store, socket: DeviceSocket, reopen: (app: string) => unknown) {
  const key = (app: string, id: string) => `${app} ${id}`;
  const split = (k: string) => {
    const at = k.lastIndexOf(" ");
    return { app: k.slice(0, at), id: k.slice(at + 1) };
  };
  /** `known`: what this device has from the space, by hash. `pending`: what the person did here that the space hasn't heard yet. */
  let state: { known: Record<string, string>; pending: Record<string, "add" | "remove"> } = { known: {}, pending: {} };
  const loaded = store.readJson<unknown>(STATE, null).then((saved) => {
    const s = saved as typeof state | null;
    if (s && typeof s === "object") state = { known: { ...s.known }, pending: { ...s.pending } };
  });
  const save = () => store.writeJson(STATE, state);

  const waiting = new Map<number, (reply: Extract<SyncToDevice, { op: "plugins:reply" }> | undefined) => void>();
  let asked = 0;
  type Ask = PluginRequest extends infer R ? (R extends PluginRequest ? Omit<R, "t" | "op" | "id"> : never) : never;
  function ask(request: Ask): Promise<Extract<SyncToDevice, { op: "plugins:reply" }> | undefined> {
    const id = ++asked;
    return new Promise((done) => {
      if (!socket.send({ t: "sync", op: "plugins", id, ...request } as PluginRequest)) return done(undefined);
      waiting.set(id, done);
      setTimeout(() => {
        if (waiting.delete(id)) done(undefined);
      }, 20_000);
    });
  }

  socket.heard.add((message) => {
    if (message.op === "plugins:reply") {
      const done = waiting.get(message.id);
      waiting.delete(message.id);
      done?.(message);
    } else if (message.op === "plugins:changed") refresh();
  });
  socket.caughtUp.add(() => refresh());
  userAdded.changed.add(({ app, added, removed }) => {
    void loaded.then(async () => {
      for (const id of added ?? []) state.pending[key(app, id)] = "add";
      if (removed) state.pending[key(app, removed)] = "remove";
      await save();
      refresh();
    });
  });

  /** One refresh at a time; one asked for meanwhile runs again after it. */
  let running: Promise<void> | undefined;
  let again = false;
  function refresh() {
    if (running) return void (again = true);
    running = loaded
      .then(sync)
      .catch((error) => trace({ kind: "error", name: "shared-plugins", detail: String(error) }))
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          refresh();
        }
      });
  }

  async function sync() {
    // First what the person did here, so the list the space sends back has it.
    for (const [k, action] of Object.entries(state.pending)) {
      const { app, id } = split(k);
      if (action === "add") {
        const files = await filesOf(store, userAdded, app, id);
        if (!files) {
          delete state.pending[k];
          continue;
        }
        const reply = await ask({ action: "add", app, files });
        if (!reply) return save();
        if (reply.ok && reply.hash) state.known[k] = reply.hash;
        else trace({ kind: "error", name: "shared-plugin:refused", plugin: id, detail: `${app}: ${reply.error}` });
      } else {
        const reply = await ask({ action: "remove", app, plugin: id });
        if (!reply) return save();
        delete state.known[k];
      }
      delete state.pending[k];
      await save();
    }

    const listed = await ask({ action: "list" });
    if (!listed?.ok || !listed.list) return;
    const there = new Set<string>();
    /** Apps with a plugin that was on here and changed or went: they start their plugins again. */
    const restart = new Set<string>();
    const wasOn = async (app: string, id: string) => (await userAdded.list(app)).some((p) => p.id === id && p.on);
    for (const s of listed.list) {
      const k = key(s.app, s.id);
      there.add(k);
      if (state.pending[k] || state.known[k] === s.hash) continue;
      const got = await ask({ action: "get", app: s.app, plugin: s.id });
      if (!got) return save();
      if (!got.ok || !got.files) continue;
      if (await wasOn(s.app, s.id)) restart.add(s.app);
      // Added quietly, so it isn't sent back; added, so it arrives off.
      const added = await userAdded.add(s.app, decode(got.files), { quiet: true });
      if (added.ok) state.known[k] = s.hash;
      else trace({ kind: "error", name: "shared-plugin:take", plugin: s.id, detail: `${s.app}: ${added.error}` });
    }
    // Shared once, and removed from the space since by someone.
    for (const k of Object.keys(state.known)) {
      if (there.has(k) || state.pending[k]) continue;
      const { app, id } = split(k);
      if (await wasOn(app, id)) restart.add(app);
      await userAdded.remove(app, id, { quiet: true });
      delete state.known[k];
    }
    await save();
    for (const app of restart) await reopen(app);
  }
}
