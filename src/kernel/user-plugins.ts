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
  /** The services it needs that not every site runs (its manifest's `services`). */
  services?: string[];
  /** The services it provides to other plugins (its manifest's `provides`). */
  provides?: string[];
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
   * with the space (std/spaces/plugins.ts). What the space sends is added with `quiet`, and isn't heard.
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
        out.push({ file, id: m.id, name: m.name, description: m.description, permissions: m.permissions, places: m.places, services: m.services ?? [], provides: Object.keys(m.provides ?? {}), on: on.includes(m.id) });
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
    /** A plugin's file and the files its manifest lists, read from this site, ready for add(). */
    async fetch(url: string): Promise<{ ok: true; files: { name: string; data: Blob | string }[]; source: string } | { ok: false; error: string }> {
      const href = new URL(url, origin);
      if (href.origin !== origin || !href.pathname.endsWith(".js")) return { ok: false, error: "Add a .js file from this site" };
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
        return { ok: true, files, source };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    /**
     * Why one plugin's files can't go in an app's folder, if they can't: they are one plugin (.js), every
     * other file is one its manifest lists, and none belongs to another of the person's plugins there
     * (which it would overwrite). A review shows the plugin's code, so nothing else may ride along with it.
     */
    async problem(app: string, files: { name: string; data: Blob | string }[]): Promise<string | undefined> {
      const plugins = files.filter((f) => f.name.endsWith(".js"));
      if (plugins.length !== 1 || typeof plugins[0].data !== "string") return "Add one plugin (.js) at a time, with the files its manifest lists";
      let manifest;
      try {
        manifest = readManifest(plugins[0].data);
      } catch (error) {
        return `${plugins[0].name}: ${error instanceof Error ? error.message : error}`;
      }
      const listed = new Set(manifest.files ?? []);
      const badName = files.find((f) => !FILE_NAME.test(f.name));
      if (badName) return `${badName.name}: a file name is letters, digits, ., - and _`;
      const extra = files.find((f) => f !== plugins[0] && !listed.has(f.name));
      if (extra) return `${extra.name} isn't one of the files ${manifest.id} lists`;
      const ours = new Set([`${manifest.id}.js`, ...listed]);
      for (const other of await list(app)) {
        if (!other.id || other.id === manifest.id) continue;
        const source = (await store.readText(`user/${app}/${other.file}`)) ?? "";
        let theirs: string[] = [];
        try {
          theirs = readManifest(source).files ?? [];
        } catch {}
        const clash = [other.file, ...theirs].find((name) => ours.has(name));
        if (clash) return `${clash} belongs to ${other.name ?? other.id}, another plugin for this app`;
      }
      return undefined;
    },

    async addFromUrl(app: string, url: string) {
      const fetched = await this.fetch(url);
      return fetched.ok ? this.add(app, fetched.files) : fetched;
    },

    on: (app: string, id: string) => setOn(checkApp(app), id, true),
    off: (app: string, id: string) => setOn(checkApp(app), id, false),

    /**
     * Turns one of the person's plugins on, and with it the ones of theirs for the app that provide the
     * services it needs (and the ones those need), so turning on World clock turns on Clock too. A service
     * the kernel has already (`has`: a kernel module's, or a running plugin's) needs nothing turned on.
     * Each was reviewed when it was added, as turning one on needs no review. Returns the others it turned on.
     */
    async onWithNeeds(app: string, id: string, has: (service: string) => boolean): Promise<UserPlugin[]> {
      const all = await list(checkApp(app));
      const also: UserPlugin[] = [];
      const plugin = all.find((p) => p.id === id);
      // What will be there once these are on: a second provider of any of it would be refused as a clash.
      const covered = new Set<string>([...(plugin?.provides ?? []), ...all.filter((p) => p.on).flatMap((p) => p.provides ?? [])]);
      const seen = new Set<string>();
      const visit = async (needer: UserPlugin) => {
        if (!needer.id || seen.has(needer.id)) return;
        seen.add(needer.id);
        for (const service of needer.services ?? []) {
          if (has(service) || covered.has(service)) continue;
          const provider = all.find((p) => p.id !== needer.id && !p.on && p.provides?.includes(service));
          if (!provider?.id) continue;
          await setOn(app, provider.id, true);
          also.push(provider);
          for (const name of provider.provides ?? []) covered.add(name);
          await visit(provider);
        }
      };
      await setOn(app, id, true);
      if (plugin) await visit(plugin);
      return also;
    },

    /**
     * Turns one of the person's plugins off, and with it the ones of theirs for the app that need a service
     * only it provides, so they don't start again without it. `elsewhere` says whether a service is running
     * from something other than this plugin (a kernel module, or the app's own plugin), which keeps the ones
     * that need it on. Returns the others it turned off.
     */
    async offWithDependents(app: string, id: string, elsewhere: (service: string, not: string) => boolean = () => false): Promise<UserPlugin[]> {
      const all = await list(checkApp(app));
      const also: UserPlugin[] = [];
      const gone = new Set<string>([id]);
      const off = async (plugin: UserPlugin) => {
        for (const service of plugin.provides ?? []) {
          if (elsewhere(service, plugin.id ?? "")) continue;
          // Another of theirs that stays on and provides it keeps it there.
          if (all.some((p) => p.on && p.id && !gone.has(p.id) && p.provides?.includes(service))) continue;
          for (const p of all) {
            if (!p.id || !p.on || gone.has(p.id) || !p.services?.includes(service)) continue;
            gone.add(p.id);
            await setOn(app, p.id, false);
            also.push(p);
            await off(p);
          }
        }
      };
      const plugin = all.find((p) => p.id === id);
      await setOn(app, id, false);
      if (plugin) await off(plugin);
      return also;
    },

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
