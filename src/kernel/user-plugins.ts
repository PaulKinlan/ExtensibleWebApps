// User plugins: the plugins a person adds to an app without editing the
// app's files. The app's author lists theirs in app.html; the person's are
// kept on this device, in the data folder, one folder per app:
//
//   user/demos/trip/countdown.js     the plugin
//   user/demos/trip/countdown.html   its templates
//   user/demos/trip/tram.png         anything else it lists in `files`
//
// A .js file there means the plugin is installed for that app. Whether it
// is on is kept in `user-plugins.json`, and a newly added plugin starts off:
// the person turns it on in the Customize panel, after seeing what it asks
// for and where it draws. The service worker serves the folder at
// /user/<app>/, so a plugin's templates and images load like any other file.
//
// A plugin the person wants in every app (a language model they added, with
// their own key, say) is kept once, in `user/_everywhere/`, and runs with
// every app they open here as if it were in that app's folder. One with the
// same id in an app's own folder, or linked by the app itself, wins there.
//
// Plugins can't write here: `user` is one of the platform's own folders
// (paths.ts), so no plugin can install another by writing files.
//
// This file is what every app needs as it opens: which of the person's
// plugins to start. Adding, removing and turning them on and off (with the
// plugins they need) is user-plugin-changes.ts, fetched the first time the
// person changes something.

import { readManifest } from "./manifest";
import type { Store } from "./store";
import { record } from "./trace";

const STATE = "user-plugins.json";
/** Where the plugins the person uses in every app are kept, in place of an app's folder. No app can have this folder: its page gets no plugins of the person's. */
export const EVERYWHERE = "_everywhere";

/** An app's folder, as the page's path names it: `demos/trip` for /demos/trip/app.html. */
export function checkApp(app: unknown): string {
  if (typeof app !== "string" || app.length > 200 || !/^[\w-]+(\/[\w-]+)*$/.test(app)) throw new Error("That isn't an app folder");
  return app;
}

export interface UserPlugin {
  file: string;
  id?: string;
  name?: string;
  description?: string;
  permissions?: string[];
  places?: Record<string, { at: string; put: string; each?: boolean }>;
  /** The services it needs that not every site runs (its manifest's `services`). */
  services?: string[];
  /** The services it provides to other plugins (its manifest's `provides`). */
  provides?: string[];
  on: boolean;
  /** It is one the person uses in every app, kept in `user/_everywhere/` rather than this app's folder. */
  everywhere?: boolean;
  /** Why its manifest couldn't be read. */
  error?: string;
}

/** The folder one of the person's plugins is kept in: the app's, or the one for every app. */
export const folderOf = (app: string, plugin: { everywhere?: boolean }) => (plugin.everywhere ? EVERYWHERE : app);

/**
 * `space` is the space whose copy this kernel keeps, if it does: the person's plugins for an app in a
 * space are kept in the space's folder, and served at /s/<space>/user/<app>/ (sw/routes/spaces.js).
 */
export function userPlugins(store: Store, origin: string, space?: string) {
  const served = `${origin}${space ? `/s/${space}` : ""}/user`;
  /** For each app, the ids of the user plugins the person turned on. */
  let state: Record<string, string[]> | undefined;
  const load = async () => {
    if (state) return state;
    const saved = await store.readJson<unknown>(STATE, {});
    state = Object.create(null) as Record<string, string[]>;
    if (saved && typeof saved === "object" && !Array.isArray(saved))
      for (const [app, ids] of Object.entries(saved)) if (Array.isArray(ids)) state[app] = ids.filter((id): id is string => typeof id === "string");
    return state;
  };
  const save = () => store.writeJson(STATE, state);
  /**
   * Who hears when a plugin is added or removed here by the person, so a device in a space can share it
   * with the space (std/spaces/plugins.ts). What the space sends is added with `quiet`, and isn't heard.
   */
  const changed = new Set<(change: { app: string; added?: string[]; removed?: string }) => void>();

  /** The plugins kept in one folder: an app's, or the one for every app. */
  async function kept(folder: string): Promise<UserPlugin[]> {
    const on = (await load())[folder] ?? [];
    const out: UserPlugin[] = [];
    for (const file of await store.listFiles(`user/${folder}`)) {
      if (!file.endsWith(".js")) continue;
      const source = (await store.readText(`user/${folder}/${file}`)) ?? "";
      try {
        const m = readManifest(source);
        out.push({ file, id: m.id, name: m.name, description: m.description, permissions: m.permissions, places: m.places, services: m.services ?? [], provides: Object.keys(m.provides ?? {}), on: on.includes(m.id) });
      } catch (error) {
        out.push({ file, on: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return out;
  }

  /** The person's plugins for an app: the ones in its folder, then the ones they use in every app (unless the app's folder has one of the same id). */
  async function list(app: string): Promise<UserPlugin[]> {
    checkApp(app);
    const own = await kept(app);
    if (app === EVERYWHERE) return own;
    const everywhere = (await kept(EVERYWHERE)).filter((p) => !p.id || !own.some((o) => o.id === p.id));
    return [...own, ...everywhere.map((p) => ({ ...p, everywhere: true }))];
  }

  async function setOn(folder: string, id: string, value: boolean): Promise<void> {
    const s = await load();
    const ids = new Set(s[folder] ?? []);
    if (value) ids.add(id);
    else ids.delete(id);
    if (ids.size) s[folder] = [...ids].sort();
    else delete s[folder];
    await save();
    record({ kind: "lifecycle", name: value ? "user-plugin:on" : "user-plugin:off", plugin: id, detail: folder });
  }
  /** Turns one on or off where it is kept: for this app, or, for one the person uses everywhere, for every app. */
  const turn = async (app: string, id: string, value: boolean) => setOn(folderOf(checkApp(app), (await list(app)).find((p) => p.id === id) ?? {}), id, value);

  /** Adding, removing and turning on with what a plugin needs (user-plugin-changes.ts), fetched when first used. */
  let changes: Promise<ReturnType<typeof import("./user-plugin-changes").userPluginChanges>> | undefined;
  const more = () => (changes ??= import("./user-plugin-changes").then((m) => m.userPluginChanges({ store, origin, list, setOn, tell: (change) => changed.forEach((heard) => heard(change)) })));
  type More = Awaited<ReturnType<typeof more>>;
  /** One of its functions, by name: the same call, made once the file is here. */
  const later = <K extends keyof More>(name: K) => (async (...args: any[]) => ((await more())[name] as (...a: any[]) => unknown)(...args)) as More[K];

  return {
    list,
    changed,

    /** The plugins to start with the app: the person's, that are on. `everywhere` marks one kept for every app, which gives way to a plugin of the same id the app links. */
    async links(app: string): Promise<{ href: string; source: string; everywhere?: boolean }[]> {
      const links = [];
      for (const p of await list(app)) {
        if (!p.on) continue;
        const folder = folderOf(app, p);
        const source = await store.readText(`user/${folder}/${p.file}`);
        if (source) links.push({ href: `${served}/${folder}/${p.file}`, source, ...(p.everywhere && { everywhere: true }) });
      }
      return links;
    },

    /** The ids of the app's user plugins, so the page can mark them. */
    async ids(app: string): Promise<Set<string>> {
      return new Set((await list(app)).flatMap((p) => (p.id ? [p.id] : [])));
    },

    /** The code of one of the person's plugins for an app, as it is kept now. */
    async read(app: string, id: string): Promise<string | undefined> {
      const plugin = (await list(app)).find((p) => p.id === id);
      return plugin ? ((await store.readText(`user/${folderOf(app, plugin)}/${plugin.file}`)) ?? "") : undefined;
    },

    on: (app: string, id: string) => turn(app, id, true),
    off: (app: string, id: string) => turn(app, id, false),

    add: later("add"),
    fetch: later("fetch"),
    problem: later("problem"),
    addFromUrl: later("addFromUrl"),
    onWithNeeds: later("onWithNeeds"),
    offWithDependents: later("offWithDependents"),
    remove: later("remove"),
    everywhere: later("everywhere"),
  };
}

export type UserPlugins = ReturnType<typeof userPlugins>;
