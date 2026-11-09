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
/** A shared plugin and its files, as sent: one WebSocket message, which Cloudflare caps at 1 MiB. */
export const MAX_BYTES = 700_000;
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
export const sizeOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** A plugin's files as they are kept for an app: the plugin, and each file its manifest lists. */
export async function filesOf(store: Store, userAdded: UserPlugins, app: string, id: string): Promise<SharedFile[] | undefined> {
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
export async function problem(userAdded: UserPlugins, app: string, files: SharedFile[]): Promise<string | undefined> {
  const plugins = files.filter((f) => f.name.endsWith(".js") && !f.name.includes("/"));
  if (plugins.length !== 1 || !("text" in plugins[0])) return "Share one plugin (.js) at a time";
  return userAdded.problem(app, decode(files));
}

/**
 * Puts a shared plugin in an app's folder, quietly (it isn't sent back to the space), and off. A plugin
 * already there with that id goes first, so files it listed and this one doesn't aren't left behind.
 */
export async function put(userAdded: UserPlugins, app: string, files: SharedFile[]) {
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
