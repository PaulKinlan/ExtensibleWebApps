// The device's side of members' plugins (plugins.ts says how sharing works): sends the plugins
// the person shares to the space, and puts the ones other members share here, turned off. Loaded
// only in a kernel for a space (on-device.ts).

import type { PluginRequest, SharedSummary, SyncToDevice } from "../../src/shared/sync";
import type { Hosts } from "../../src/kernel/hosts";
import type { Store } from "../../src/kernel/store";
import { record as trace } from "../../src/kernel/trace";
import type { UserPlugins } from "../../src/kernel/user-plugins";
import { EVERYWHERE } from "../../src/kernel/user-plugins";
import { MAX_BYTES, decode, filesOf, problem, put, sizeOf } from "./plugins";

const STATE = "sync/plugins.json";

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
        // Known before the files land, so a list in between already says it's the space's. `put` is quiet, so it isn't sent back.
        state.known[k] = s.hash;
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
      const own = (await userAdded.list(app)).find((p) => p.id === id);
      if (!own) return false;
      if (own.everywhere) {
        // One the person uses in every app: a copy for this app is what the space gets, on here as theirs was. Theirs stays in every app.
        const files = await filesOf(store, userAdded, EVERYWHERE, id);
        if (!files) return false;
        // Not over a file another of this app's plugins has: the app is left as it was.
        const wrong = await problem(userAdded, app, files);
        if (wrong) throw new Error(`This plugin can't be copied into this app to share it: ${wrong}. Rename that file in one of the two, then share again.`);
        const copied = await userAdded.add(app, decode(files), { quiet: true });
        if (!copied.ok) throw new Error(copied.error);
        if (own.on) await userAdded.mark(app, id, true);
        await reopen(app);
      }
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
