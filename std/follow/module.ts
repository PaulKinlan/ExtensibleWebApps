// The `follow` module: what a signed-in person adds follows them. The plugins
// and agents they added (to one app or to every app), which of them are on,
// where they moved views, and the model they picked are sent to their account
// on the site's server (src/server/auth/follow.ts), and what they did on their
// other devices is brought here. Never an API key: keys stay in each device's
// own secrets.json, so a model that came from the account asks for its key
// once on each device.
// A kernel module (docs/layers.md): a site that lists `follow` in kernel.json
// has it. It starts only on a device where someone is signed in
// (`"starts": "account"`), so signed out nothing here is fetched or run, and
// everything a person adds stays on the device as it always did.
//
// What it follows, each as one item the account keeps under a key:
//
//   file:demos/trip/countdown.js      a file in user/: a plugin, an agent, what it lists in `files`
//   on:demos/trip/countdown           that plugin is on (user-plugins.json)
//   move:demos/trip|countdown|main    where a view was moved to (moves/)
//   llm:prefer                        the model that answers when a request names none (llm.json)
//
// It reads these from the data folder, hashes each, and keeps the hash it last
// agreed with the account (`sync/account.json`). An item whose hash differs
// from that was changed here, and goes up; one the account says is newer comes
// down, unless it was changed here since (then this device's goes up, and is
// the one kept). What comes down is written through the same parts of the
// kernel a person's own change goes through, and the apps it touches open
// again, so it shows without a reload.
//
// In a kernel for a space only what is the person's everywhere follows: their
// every-app plugins, moves and model. An app's plugins there are that space's
// copy, some of them shared with its members (std/spaces/plugins.ts).
//
// It syncs when it starts, when one of those files changes, when a tab opens
// or goes to another screen, and once a minute while a tab is open.

import { env } from "../../src/kernel/env";
import { SIGNED_IN, type ModuleKernel } from "../../src/kernel/modules";
import { asMove } from "../../src/kernel/moves";
import type { ServiceProvider } from "../../src/kernel/remote";
import { record } from "../../src/kernel/trace";
import { EVERYWHERE, folderOf } from "../../src/kernel/user-plugins";

const STATE = "sync/account.json";
const AT = "/auth/follow";
/** The same names the account takes (src/server/auth/follow.ts). */
const KEY = /^[a-z]{1,12}:[\w.~|/-]{1,300}$/;
/** A file in user/: an app's folder (or the one for every app), then the file, which may be in a plugin's own folder. */
const FILE = /^[\w-]+(\/[\w-][\w.-]*)+$/;
const TEXT = /\.(js|mjs|html|css|json|svg|txt|md)$/i;
/** One item as sent, and one request's worth of them: under what the account takes. */
const MAX_ITEM = 250 * 1024;
const MAX_REQUEST = 500 * 1024;
const EVERY = 60_000;
const SOON = 800;

interface State {
  user?: string;
  name?: string;
  /** The account's number for the last change this device has. */
  version: number;
  /** Each item's hash as this device and the account last agreed on it. */
  known: Record<string, string>;
  /** The items that came from the account, rather than being added here. */
  from: string[];
  /** When it last agreed with the account. */
  at?: number;
}

/** What the person is told (Customize shows it). */
export interface Following {
  /** Signed in, and the account answers. */
  on: boolean;
  name?: string;
  /** When this device last agreed with the account, as ISO text. */
  at?: string;
  /** Why the last try didn't work, in words for the person. */
  error?: string;
  /** Files too big for the account to keep, which stay on this device. */
  skipped: string[];
  /** The ids of the app's plugins and agents that came from the account. */
  from: string[];
}

type Item = { key: string; v: number; h?: string; value?: unknown; gone?: true };

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (data: Uint8Array | string) => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : (data as BufferSource))).slice(0, 40);
const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
/** A file's bytes as text, if they are text that reads back as the same bytes. */
const asText = (bytes: Uint8Array): string | undefined => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const again = new TextEncoder().encode(text);
    return again.length === bytes.length && again.every((b, i) => b === bytes[i]) ? text : undefined;
  } catch {
    return undefined;
  }
};

export default {
  name: "follow",
  apply(_ctx: unknown, kernel: ModuleKernel) {
    const { root, store, hosts, userAdded, moved } = kernel;
    const where = env();
    if (where.kind === "server") {
      // A space's server has no one signed in: the service is there, and says so.
      kernel.provide("follow", { description: "", methods: {}, capability: () => "plugins:read", call: () => ({ on: false, skipped: [], from: [] }) });
      return;
    }
    const inSpace = !!where.space;
    /** Whether an item follows the person from this kernel: in a space, only what is theirs everywhere. */
    const wanted = (key: string) => KEY.test(key) && (!inSpace || /^(file|on):_everywhere\/|^move:|^llm:/.test(key));

    let state: State | undefined;
    const load = async () => {
      if (state) return state;
      const saved = await store.readJson<Partial<State> | null>(STATE, null);
      state = {
        user: typeof saved?.user === "string" ? saved.user : undefined,
        name: typeof saved?.name === "string" ? saved.name : undefined,
        version: Number.isSafeInteger(saved?.version) ? saved!.version! : 0,
        known: saved?.known && typeof saved.known === "object" ? { ...saved.known } : {},
        from: Array.isArray(saved?.from) ? saved!.from.filter((k) => typeof k === "string") : [],
        at: typeof saved?.at === "number" ? saved.at : undefined,
      };
      return state;
    };
    const status = { on: false, error: undefined as string | undefined, skipped: [] as string[] };

    /** Everything on this device that follows the person, by key: its hash now, and how to read its value. */
    async function here(): Promise<Map<string, { h: string; value: () => unknown }>> {
      const out = new Map<string, { h: string; value: () => unknown }>();
      const add = async (key: string, value: unknown) => void (wanted(key) && out.set(key, { h: await sha(JSON.stringify(value)), value: () => value }));
      for (const path of await store.listAll("user")) {
        const rel = path.slice("user/".length);
        const key = `file:${rel}`;
        if (!FILE.test(rel) || !wanted(key)) continue;
        const bytes = await store.readBytes(path);
        if (!bytes) continue;
        out.set(key, {
          h: await sha(bytes),
          value: () => {
            const text = TEXT.test(rel) ? asText(bytes) : undefined;
            return text === undefined ? { b: toBase64(bytes) } : { t: text };
          },
        });
      }
      const on = await store.readJson<Record<string, unknown>>("user-plugins.json", {});
      for (const [folder, ids] of Object.entries(on ?? {})) if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") await add(`on:${folder}/${id}`, true);
      for (const name of await store.listFiles("moves")) {
        if (!name.endsWith(".json")) continue;
        const app = name.slice(0, -".json".length).replace(/~/g, "/");
        for (const [plugin, places] of Object.entries(await moved.get(app))) for (const [place, to] of Object.entries(places)) await add(`move:${app}|${plugin}|${place}`, to);
      }
      const prefer = (await store.readJson<{ prefer?: unknown }>("llm.json", {}))?.prefer;
      if (typeof prefer === "string" && prefer) await add("llm:prefer", prefer);
      return out;
    }

    /** While it writes what the account sent, the files it writes aren't changes the person made. */
    let applying = false;
    /** Writes one item as the account has it (`value` undefined: it was removed). Says whether it could. */
    async function put(key: string, value: unknown): Promise<boolean> {
      const [kind, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      try {
        if (kind === "file") {
          if (!FILE.test(name)) return false;
          const v = value as { t?: unknown; b?: unknown } | undefined;
          if (v === undefined) await store.removeFile(`user/${name}`);
          else if (typeof v.t === "string") await store.writeFile(`user/${name}`, v.t);
          else if (typeof v.b === "string") await store.writeFile(`user/${name}`, new Blob([fromBase64(v.b) as BlobPart]));
          else return false;
          return true;
        }
        if (kind === "on") {
          const at = name.lastIndexOf("/");
          if (at < 1) return false;
          await (value === undefined ? userAdded.off : userAdded.on)(name.slice(0, at), name.slice(at + 1));
          return true;
        }
        if (kind === "move") {
          const [app, plugin, place] = name.split("|");
          const to = value === undefined ? null : asMove(value);
          if (!app || !plugin || !place || to === undefined || !/^[\w-]+(\/[\w-]+)*$/.test(app)) return false;
          await moved.set(app, plugin, place, to);
          return true;
        }
        if (key === "llm:prefer") {
          if (value !== undefined && typeof value !== "string") return false;
          await store.writeJson("llm.json", value ? { prefer: value } : {});
          return true;
        }
      } catch (error) {
        record({ kind: "error", name: "follow:not-kept", detail: `${key}: ${error instanceof Error ? error.message : String(error)}` });
      }
      return false;
    }
    /** The apps open here that an item is part of, to open again once it changed. */
    const touches = (key: string, app: string) => /^(file|on):_everywhere\//.test(key) || key === "llm:prefer" || key.startsWith(`file:${app}/`) || key.startsWith(`on:${app}/`) || key.startsWith(`move:${app}|`);

    const ask = async (path: string, body?: unknown): Promise<{ status: number; data: any }> => {
      const res = await fetch(new URL(path, self.location.origin), body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const isJson = (res.headers.get("content-type") ?? "").includes("json");
      // A site with no server answers with a page, or nothing: there is no account to follow.
      return { status: isJson ? res.status : 404, data: isJson ? await res.json().catch(() => ({})) : {} };
    };

    let stopped = false;
    /** One round with the account: what is newer there comes here, then what changed here goes there. */
    async function round(): Promise<void> {
      // Signed out, nothing is asked of the server: the account app leaves a mark on the device while someone is signed in.
      if (!inSpace && (await store.readText(SIGNED_IN)) === undefined) {
        status.on = false;
        stopped = true;
        return;
      }
      const s = await load();
      const pulled = await ask(`${AT}?since=${s.version}`);
      if (pulled.status === 401 || pulled.status === 404) {
        // Signed out (or the site has no accounts): everything stays as it is on this device, and nothing more is asked.
        status.on = false;
        status.error = undefined;
        stopped = true;
        if (!inSpace) await store.removeFile(SIGNED_IN).catch(() => {});
        record({ kind: "lifecycle", name: "follow:signed-out", plugin: "follow" });
        return;
      }
      if (pulled.status !== 200) throw new Error(typeof pulled.data.error === "string" ? pulled.data.error : `The site's server answered ${pulled.status}`);
      if (s.user && s.user !== pulled.data.user) {
        // Someone else signed in on this device: what is here is compared with their account from the start.
        state = { version: 0, known: {}, from: [], user: pulled.data.user };
        await store.writeJson(STATE, state);
        return round();
      }
      s.user = pulled.data.user;
      s.name = pulled.data.name;
      status.on = true;

      let mine = await here();
      const from = new Set(s.from);
      const arrived: string[] = [];
      // A plugin's files before the mark that turns it on.
      const items = (Array.isArray(pulled.data.items) ? (pulled.data.items as Item[]) : []).filter((i) => i && typeof i.key === "string" && wanted(i.key)).sort((a, b) => Number(b.key.startsWith("file:")) - Number(a.key.startsWith("file:")));
      applying = true;
      try {
        for (const item of items) {
          const local = mine.get(item.key)?.h;
          const known = s.known[item.key];
          if (item.gone ? local === undefined : local === item.h) {
            // Already the same here.
            if (item.gone) delete s.known[item.key];
            else s.known[item.key] = item.h!;
            continue;
          }
          // Changed here since this device last agreed with the account: this device's goes up instead.
          if (item.gone ? local !== known : known !== undefined && local !== known) continue;
          if (!(await put(item.key, item.gone ? undefined : item.value))) continue;
          if (item.gone) {
            delete s.known[item.key];
            from.delete(item.key);
          } else {
            s.known[item.key] = item.h!;
            from.add(item.key);
          }
          arrived.push(item.key);
          // Kept as it goes: a kernel that stops half way (its last tab closed) knows what it already has when it starts again.
          s.from = [...from].sort();
          await store.writeJson(STATE, s);
        }
      } finally {
        applying = false;
      }
      s.version = Number(pulled.data.version) || s.version;
      s.from = [...from].sort();
      if (arrived.length) {
        record({ kind: "lifecycle", name: "follow:arrived", plugin: "follow", detail: `${arrived.length} from your account` });
        mine = await here();
      }

      const changes: { key: string; h?: string; value?: unknown; gone?: true; size: number }[] = [];
      const skipped: string[] = [];
      for (const [key, item] of mine) {
        if (s.known[key] === item.h) continue;
        const value = item.value();
        const size = JSON.stringify(value).length;
        if (size > MAX_ITEM) skipped.push(key.slice(key.indexOf(":") + 1));
        else changes.push({ key, h: item.h, value, size });
      }
      for (const key of Object.keys(s.known)) if (!mine.has(key) && wanted(key)) changes.push({ key, gone: true, size: 0 });
      status.skipped = skipped;
      while (changes.length) {
        const batch = [];
        for (let size = 0; changes.length && (!batch.length || size + changes[0].size <= MAX_REQUEST); size += batch[batch.length - 1].size) batch.push(changes.shift()!);
        const sent = await ask(AT, { changes: batch.map(({ size: _size, ...change }) => change) });
        if (sent.status !== 200) throw new Error(typeof sent.data.error === "string" ? sent.data.error : `The site's server answered ${sent.status}`);
        for (const change of batch) {
          if (change.gone) delete s.known[change.key];
          else s.known[change.key] = change.h!;
          from.delete(change.key);
        }
        const saved = Array.isArray(sent.data.saved) ? sent.data.saved.length : 0;
        // Only this device changed the account since it last asked: it has everything up to here.
        if (sent.data.version === s.version + saved) s.version = sent.data.version;
        record({ kind: "lifecycle", name: "follow:sent", plugin: "follow", detail: `${saved} to your account` });
      }
      s.from = [...from].sort();
      s.at = Date.now();
      status.error = undefined;
      await store.writeJson(STATE, s);
      record({ kind: "lifecycle", name: "follow:synced", plugin: "follow", detail: `version ${s.version}` });

      if (arrived.length) {
        if (arrived.some((key) => /^(file|on):_everywhere\//.test(key) || key === "llm:prefer")) await kernel.reopen(EVERYWHERE);
        else for (const app of new Set(hosts.list.map((host) => kernel.appIn(host.tab)).filter((app): app is string => !!app))) if (arrived.some((key) => touches(key, app))) await kernel.reopen(app);
      }
    }

    /** One round at a time; a change while one runs is another round after it. */
    let running: Promise<void> | undefined;
    let again = false;
    const sync = (): Promise<void> => {
      if (running) {
        again = true;
        return running;
      }
      stopped = false;
      running = (async () => {
        do {
          again = false;
          await round().catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            status.error = /fetch|network|load failed/i.test(detail) ? "Couldn't reach your account: this device looks offline. What you add is kept here and sent when you're back online." : detail;
            record({ kind: "error", name: "follow:failed", plugin: "follow", detail });
          });
        } while (again && !stopped);
      })().finally(() => (running = undefined));
      return running;
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(() => void sync(), SOON);
    };
    const changed = (path: string) => {
      if (!applying && (path.startsWith("user/") || path.startsWith("moves/") || path === "user-plugins.json" || path === "llm.json")) soon();
    };
    store.changed.add(changed);
    let last = 0;
    const visit = () => {
      if (stopped || Date.now() - last < 15_000) return;
      last = Date.now();
      void sync();
    };
    root.on("internal/url", visit);
    // The person signed in on this device (std/account says so).
    root.on("internal/account", () => void sync());
    const every = setInterval(() => hosts.list.length && !stopped && void sync(), EVERY);
    kernel.cleanup(() => {
      store.changed.delete(changed);
      clearTimeout(timer);
      clearInterval(every);
    });

    const following = async (app?: unknown): Promise<Following> => {
      const s = await load();
      const from = new Set(s.from);
      const ids = typeof app === "string" && status.on ? (await userAdded.list(app).catch(() => [])).filter((p) => p.id && from.has(`file:${folderOf(app, p)}/${p.file}`)).map((p) => p.id!) : [];
      return { on: status.on, ...(status.on && { name: s.name, at: s.at ? new Date(s.at).toISOString() : undefined }), ...(status.error && { error: status.error }), skipped: status.skipped, from: ids };
    };
    const provider: ServiceProvider = {
      description: "What the signed-in person added, following them between their devices: their plugins and agents, which are on, where they moved views and the model they picked go to their account on the site's server, and come from it. Never an API key.",
      methods: {
        status: {
          args: "(app?)",
          returns: "{ on, name?, at?, error?, skipped, from }",
          needs: "plugins:read",
          params: [{ name: "app", schema: { type: "string", description: "An app's folder (demos/trip), to hear which of its plugins came from the account; left out, the app open in the caller's tab" } }],
          description: "Whether this device follows an account (`on`: someone is signed in and the account answers), whose, when they last agreed (`at`), why the last try failed (`error`, in words for the person), the files too big to follow (`skipped`), and the ids of the app's plugins and agents that came from the account (`from`).",
        },
        now: {
          args: "(app?)",
          returns: "{ on, name?, at?, error?, skipped, from }",
          needs: "plugins:manage",
          params: [{ name: "app", schema: { type: "string", description: "As for status" } }],
          description: "Sends what changed here and brings what changed elsewhere now, rather than within the minute, then answers as status does.",
        },
      },
      capability: (method) => (method === "now" ? "plugins:manage" : "plugins:read"),
      call: async (instance, method, args) => {
        if (method === "now") await sync();
        else if (method !== "status") throw new Error(`follow has no ${method}`);
        else await first;
        // Without an app named, the one open in the caller's tab.
        return following(typeof args[0] === "string" ? args[0] : kernel.appIn(instance.split("@")[1] ?? ""));
      },
    };
    kernel.provide("follow", provider);
    // For tests and developer tools: window.__host.command("follow", app) syncs now and says how it stands.
    kernel.command("follow", async (app) => {
      await sync();
      return following(app);
    });

    // Once the data folder is there (the first page said hello), and then as above.
    const first = kernel.started() ? sync() : new Promise<void>((done) => root.on("internal/started", () => void sync().then(done)));
  },
};
