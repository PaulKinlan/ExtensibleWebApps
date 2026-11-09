// Space plugins: an app has three levels of plugins. The developer's, which
// app.html links; the space's, which its members share with each other; and
// each person's own, which stay private on their device. A plugin a person
// adds is their own; in a space (Customize, at /s/<space>/…) they can share it
// with the space, and then it goes to every member's browser. It never runs
// on the space's server, which runs only the plugins an app's app.html links
// (server-apps.ts); the space only keeps its files and hands them out.
//
// Each device decides for itself whether to run a space plugin. One someone
// else shared arrives turned off, as any plugin added to an app does, and the
// person turns it on in Customize after seeing what it asks for. When someone
// changes it, it arrives off again. Removing a space plugin removes it from
// the space and from every member's device; stopping sharing it keeps it on
// the device that stopped, as that person's own again.
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

import type { PluginRequest, SharedFile, SharedSummary, SyncToDevice } from "../../src/shared/sync";
import type { Host, Hosts } from "../../src/kernel/hosts";
import { readManifest } from "../../src/kernel/manifest";
import type { Store } from "../../src/kernel/store";
import { record as trace } from "../../src/kernel/trace";
import { checkApp, type UserPlugins } from "../../src/kernel/user-plugins";

const INDEX = "user/shared.json";
const STATE = "sync/plugins.json";
/** A shared plugin and its files, as sent: one WebSocket message, which Cloudflare caps at 1 MiB. */
const MAX_BYTES = 700_000;
const MAX_PLUGINS = 200;
const TEXT = /\.(js|mjs|html|css|json|svg|txt|md)$/i;
const ID = /^[\w-]{1,64}$/;
const FILE_NAME = /^[\w-][\w.-]{0,63}$/;

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
/** Bytes as sent, in UTF-8: what the WebSocket limit counts. */
const sizeOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

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

/**
 * Why a shared plugin can't go in an app's folder, if it can't: it is one plugin, every other file is one
 * its manifest lists, and none of its files belongs to another plugin there (which it would overwrite).
 */
async function problem(userAdded: UserPlugins, app: string, files: SharedFile[]): Promise<string | undefined> {
  const plugins = files.filter((f) => f.name.endsWith(".js") && !f.name.includes("/"));
  if (plugins.length !== 1 || !("text" in plugins[0])) return "Share one plugin (.js) at a time";
  return userAdded.problem(app, decode(files));
}

/**
 * Puts a shared plugin in an app's folder, quietly (it isn't sent back to the space), and off. A plugin
 * already there with that id goes first, so files it listed and this one doesn't aren't left behind.
 */
async function put(userAdded: UserPlugins, app: string, files: SharedFile[]) {
  const source = files.find((f) => f.name.endsWith(".js") && !f.name.includes("/"));
  const id = source && "text" in source ? readManifest(source.text).id : undefined;
  if (id) await userAdded.remove(app, id, { quiet: true });
  return userAdded.add(app, decode(files), { quiet: true });
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
      return serially(async () => {
        const wrong = await problem(userAdded, app, m.files);
        if (wrong) return { ok: false, error: wrong };
        const added = await put(userAdded, app, m.files);
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
    /** The plugins members share, for a member's debugger (reflect.ts): kept here, never run. */
    async list(): Promise<SharedSummary[]> {
      await loaded;
      return Object.entries(index).flatMap(([app, plugins]) => Object.entries(plugins).map(([id, p]) => ({ app, id, ...p })));
    },
    /** A shared plugin's code, from whichever app keeps it, or undefined. */
    async code(id: string): Promise<string | undefined> {
      await loaded;
      for (const [app, plugins] of Object.entries(index)) {
        if (!plugins[id]) continue;
        const first = (await filesOf(store, userAdded, app, id))?.[0];
        if (first && "text" in first) return first.text;
      }
      return undefined;
    },
  };
}

/** What a device's sync (device.ts) gives this: its socket, and what it hears on it. */
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
export function devicePlugins(userAdded: UserPlugins, store: Store, hosts: Hosts, socket: DeviceSocket, reopen: (app: string) => unknown) {
  const key = (app: string, id: string) => `${app} ${id}`;
  const split = (k: string) => {
    const at = k.lastIndexOf(" ");
    return { app: k.slice(0, at), id: k.slice(at + 1) };
  };
  /**
   * `known`: what this device has from the space, by hash. `pending`: what the person did here that the space
   * hasn't heard yet, each numbered, so the answer to one doesn't clear a newer one made while it was out.
   */
  let state: { known: Record<string, string>; pending: Record<string, { action: "add" | "remove"; n: number }>; n: number } = { known: {}, pending: {}, n: 0 };
  const loaded = store.readJson<unknown>(STATE, null).then((saved) => {
    const s = saved as typeof state | null;
    if (s && typeof s === "object") state = { known: { ...s.known }, pending: { ...s.pending }, n: Number(s.n) || 0 };
  });
  const settled = (k: string, n: number) => {
    if (state.pending[k]?.n === n) delete state.pending[k];
  };
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
  /** Whether a plugin here is the space's: it came from the space, or the person shared it and it's on its way. */
  const isShared = (k: string) => k in state.known ? state.pending[k]?.action !== "remove" : state.pending[k]?.action === "add";
  const mark = async (k: string, action: "add" | "remove") => {
    await loaded;
    state.pending[k] = { action, n: ++state.n };
    await save();
    refresh();
  };
  // A person's own plugins stay theirs. A new version of a space plugin, made here, goes to the space; one removed here goes from it.
  const changed = ({ app, added, removed }: { app: string; added?: string[]; removed?: string }) => {
    void loaded.then(async () => {
      for (const id of added ?? []) if (isShared(key(app, id))) await mark(key(app, id), "add");
      if (removed && isShared(key(app, removed))) await mark(key(app, removed), "remove");
    });
  };
  userAdded.changed.add(changed);

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
    for (const [k, { action, n }] of Object.entries(state.pending)) {
      const { app, id } = split(k);
      if (action === "add") {
        const files = await filesOf(store, userAdded, app, id);
        // Over the limit, it would never fit: say so, rather than send it again at every connection.
        const tooBig = files && sizeOf(files) > MAX_BYTES;
        if (!files || tooBig) {
          if (tooBig) refused(app, id, "it and its files are over 700 KB");
          settled(k, n);
          continue;
        }
        const reply = await ask({ action: "add", app, files });
        if (!reply) return save();
        if (reply.ok && reply.hash) state.known[k] = reply.hash;
        else refused(app, id, reply.error ?? "the space didn't take it");
      } else {
        const reply = await ask({ action: "remove", app, plugin: id });
        if (!reply) return save();
        delete state.known[k];
      }
      settled(k, n);
      await save();
    }

    const listed = await ask({ action: "list" });
    if (!listed?.ok || !listed.list) return;
    /** Apps with a plugin that was on here and changed or went: they start their plugins again, however this ends. */
    const restart = new Set<string>();
    try {
      await take(listed.list, restart);
    } finally {
      await save();
      for (const app of restart) await reopen(app);
    }
  }

  function refused(app: string, id: string, why: string) {
    trace({ kind: "error", name: "shared-plugin:refused", plugin: id, detail: `${app}: ${why}` });
    hosts.broadcast({ t: "notice", text: `${id} wasn't shared with the space: ${why}. It's still on this device.`, tone: "error" });
  }

  /** Puts what the space lists here: the plugins this device hasn't got, and takes away the ones that went. */
  async function take(list: SharedSummary[], restart: Set<string>) {
    const there = new Set<string>();
    const wasOn = async (app: string, id: string) => (await userAdded.list(app)).some((p) => p.id === id && p.on);
    for (const s of list) {
      const k = key(s.app, s.id);
      there.add(k);
      if (state.pending[k] || state.known[k] === s.hash) continue;
      const got = await ask({ action: "get", app: s.app, plugin: s.id });
      if (!got) return;
      if (!got.ok || !got.files) continue;
      // The space checked it, but this device may have a plugin of its own that the files would overwrite.
      const wrong = await problem(userAdded, s.app, got.files);
      let error = wrong;
      // Kept by its hash either way, so a plugin that can't go here isn't fetched again and again. Known before its
      // files are written, so a list made as they land already says it is the space's (not, for a moment, the person's own).
      state.known[k] = s.hash;
      if (!wrong) {
        if (await wasOn(s.app, s.id)) restart.add(s.app);
        const added = await put(userAdded, s.app, got.files);
        if (!added.ok) error = added.error;
      }
      if (error) trace({ kind: "error", name: "shared-plugin:take", plugin: s.id, detail: `${s.app}: ${error}` });
    }
    // Shared once, and removed from the space since by someone.
    for (const k of Object.keys(state.known)) {
      if (there.has(k) || state.pending[k]) continue;
      const { app, id } = split(k);
      if (await wasOn(app, id)) restart.add(app);
      await userAdded.remove(app, id, { quiet: true });
      delete state.known[k];
    }
  }

  return {
    /** The app's plugins on this device, each saying whether it is the space's. */
    async mark<T extends { id?: string }>(app: string, plugins: T[]): Promise<(T & { shared: boolean })[]> {
      await loaded;
      return plugins.map((p) => ({ ...p, shared: !!p.id && isShared(key(app, p.id)) }));
    },
    /** Shares one of the person's own plugins with the space. */
    async share(app: string, id: string): Promise<boolean> {
      if (!(await userAdded.list(app)).some((p) => p.id === id)) return false;
      await mark(key(app, id), "add");
      return true;
    },
    /** Stops sharing a space plugin: it goes from the space and every other device, and stays here as the person's own. */
    async unshare(app: string, id: string): Promise<boolean> {
      await loaded;
      if (!isShared(key(app, id))) return false;
      await mark(key(app, id), "remove");
      return true;
    },
    /** Stops hearing the person's changes, when the spaces module stops. */
    stop() {
      userAdded.changed.delete(changed);
    },
  };
}
