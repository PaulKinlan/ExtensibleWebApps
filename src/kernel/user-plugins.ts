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
// Plugins can't write here: `user` is one of the platform's own folders
// (paths.ts), so no plugin can install another by writing files.

import { readManifest } from "./manifest";
import type { Store } from "./store";
import { record } from "./trace";

const STATE = "user-plugins.json";
const FILE_NAME = /^[\w-][\w.-]{0,63}$/;
const MAX_BYTES = 5_000_000;

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
  on: boolean;
  /** Why its manifest couldn't be read. */
  error?: string;
}

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
   * with the space (shared-plugins.ts). What the space sends is added with `quiet`, and isn't heard.
   */
  const changed = new Set<(change: { app: string; added?: string[]; removed?: string }) => void>();
  const tell = (change: { app: string; added?: string[]; removed?: string }) => {
    for (const heard of changed) heard(change);
  };

  async function list(app: string): Promise<UserPlugin[]> {
    checkApp(app);
    const on = (await load())[app] ?? [];
    const out: UserPlugin[] = [];
    for (const file of await store.listFiles(`user/${app}`)) {
      if (!file.endsWith(".js")) continue;
      const source = (await store.readText(`user/${app}/${file}`)) ?? "";
      try {
        const m = readManifest(source);
        out.push({ file, id: m.id, name: m.name, description: m.description, permissions: m.permissions, places: m.places, on: on.includes(m.id) });
      } catch (error) {
        out.push({ file, on: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return out;
  }

  async function setOn(app: string, id: string, value: boolean): Promise<void> {
    const s = await load();
    const ids = new Set(s[app] ?? []);
    if (value) ids.add(id);
    else ids.delete(id);
    if (ids.size) s[app] = [...ids].sort();
    else delete s[app];
    await save();
    record({ kind: "lifecycle", name: value ? "user-plugin:on" : "user-plugin:off", plugin: id, detail: app });
  }

  return {
    list,
    changed,

    /** The plugins to start with the app: the person's, that are on. */
    async links(app: string): Promise<{ href: string; source: string }[]> {
      const links = [];
      for (const p of await list(app)) {
        if (!p.on) continue;
        const source = await store.readText(`user/${app}/${p.file}`);
        if (source) links.push({ href: `${served}/${app}/${p.file}`, source });
      }
      return links;
    },

    /** The ids of the app's user plugins, so the page can mark them. */
    async ids(app: string): Promise<Set<string>> {
      return new Set((await list(app)).flatMap((p) => (p.id ? [p.id] : [])));
    },

    /**
     * Adds files to an app's folder: plugins (.js) and the files they bring. Each plugin's manifest is
     * read first, and nothing is written if any is refused. A plugin that is added starts off.
     */
    async add(app: string, files: { name: string; data: Blob | string }[], { quiet = false } = {}): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
      checkApp(app);
      if (!Array.isArray(files) || !files.length || files.length > 21) return { ok: false, error: "Add between 1 and 21 files" };
      const ids: string[] = [];
      /** A plugin is kept as <id>.js, whatever its file was called, so each id has one file. */
      const names = new Map<(typeof files)[number], string>();
      for (const f of files) {
        if (!f || typeof f.name !== "string" || !FILE_NAME.test(f.name)) return { ok: false, error: `${f?.name}: a file name is letters, digits, ., - and _` };
        if (!(typeof f.data === "string" || f.data instanceof Blob)) return { ok: false, error: `${f.name}: no contents` };
        const size = typeof f.data === "string" ? f.data.length : f.data.size;
        if (size > MAX_BYTES) return { ok: false, error: `${f.name} is over 5 MB` };
        if (!f.name.endsWith(".js")) continue;
        try {
          const id = readManifest(typeof f.data === "string" ? f.data : await f.data.text()).id;
          ids.push(id);
          names.set(f, `${id}.js`);
        } catch (error) {
          return { ok: false, error: `${f.name}: ${error instanceof Error ? error.message : error}` };
        }
      }
      if (!ids.length) return { ok: false, error: "Add at least one plugin (.js)" };
      for (const f of files) await store.writeFile(`user/${app}/${names.get(f) ?? f.name}`, f.data);
      for (const id of ids) await setOn(app, id, false);
      record({ kind: "lifecycle", name: "user-plugin:add", detail: `${app}: ${files.map((f) => f.name).join(", ")}` });
      if (!quiet) tell({ app, added: ids });
      return { ok: true, ids };
    },

    /**
     * Adds a plugin from a URL on this site, with the files its manifest lists next to it: how the demos'
     * sample plugins are added, and how a person adds one they found elsewhere on the site.
     */
    async addFromUrl(app: string, url: string) {
      const href = new URL(url, origin);
      if (href.origin !== origin || !href.pathname.endsWith(".js")) return { ok: false as const, error: "Add a .js file from this site" };
      const get = async (u: URL) => {
        const response = await fetch(u);
        if (!response.ok) throw new Error(`${u.pathname} answered ${response.status}`);
        return response.blob();
      };
      try {
        const source = await (await get(href)).text();
        const manifest = readManifest(source);
        const files: { name: string; data: Blob | string }[] = [{ name: href.pathname.split("/").pop()!, data: source }];
        for (const name of manifest.files ?? []) files.push({ name, data: await get(new URL(name, href)) });
        return this.add(app, files);
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    },

    on: (app: string, id: string) => setOn(checkApp(app), id, true),
    off: (app: string, id: string) => setOn(checkApp(app), id, false),

    /** Removes a plugin and the files its manifest lists. */
    async remove(app: string, id: string, { quiet = false } = {}): Promise<boolean> {
      const plugin = (await list(app)).find((p) => p.id === id);
      if (!plugin) return false;
      const source = (await store.readText(`user/${app}/${plugin.file}`)) ?? "";
      const files = readManifest(source).files ?? [];
      for (const name of [plugin.file, ...files]) if (FILE_NAME.test(name)) await store.removeFile(`user/${app}/${name}`);
      await setOn(app, id, false);
      record({ kind: "lifecycle", name: "user-plugin:remove", plugin: id, detail: app });
      if (!quiet) tell({ app, removed: id });
      return true;
    },
  };
}

export type UserPlugins = ReturnType<typeof userPlugins>;
