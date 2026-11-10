// Changes to the plugins a person added to an app (user-plugins.ts): adding
// one with the files it lists, removing it, turning it on with the plugins of
// theirs that provide what it needs, turning it off with the ones that need
// it, and moving one between an app's folder and the folder for every app.
//
// An app that opens only needs to know which of the person's plugins to
// start, so that part is user-plugins.ts, in the kernel's own file. This
// part is fetched the first time something changes: the person opens
// Customize, a plugin they made is saved, a space sends a shared one.

import { FILE_PATH, readManifest } from "./manifest";
import type { Store } from "./store";
import { record } from "./trace";
import { checkApp, EVERYWHERE, folderOf, type UserPlugin } from "./user-plugins";

const FILE_NAME = /^[\w-][\w.-]{0,63}$/;
/** A plugin is a .js file at the top of the app's folder; a .js file in a folder below it is one of a plugin's files, such as a template. */
const isPlugin = (name: string) => name.endsWith(".js") && !name.includes("/");
const MAX_BYTES = 5_000_000;

type File = { name: string; data: Blob | string };

/** What this needs from user-plugins.ts: the folder, the lists it keeps, and who hears a change. */
export interface Kept {
  store: Store;
  origin: string;
  list(app: string): Promise<UserPlugin[]>;
  /** Turns a plugin on or off in the folder it is kept in: an app's, or the one for every app. */
  setOn(folder: string, id: string, value: boolean): Promise<void>;
  tell(change: { app: string; added?: string[]; removed?: string }): void;
}

export function userPluginChanges({ store, origin, list, setOn, tell }: Kept) {
  /**
   * Turns off the person's plugins for an app that need a service `plugin` provided, now it doesn't, and the
   * ones that need theirs in turn. A service running from something else (`elsewhere`: a kernel module, the
   * app's own plugin) or provided by another of theirs that stays on keeps the plugins that need it on.
   * `gone` holds the ids that are off, or going; returns the ones it turned off.
   */
  async function dropDependents(app: string, all: UserPlugin[], gone: Set<string>, plugin: UserPlugin, elsewhere: (service: string, not: string) => boolean): Promise<UserPlugin[]> {
    const also: UserPlugin[] = [];
    const off = async (provider: UserPlugin) => {
      for (const service of provider.provides ?? []) {
        if (elsewhere(service, provider.id ?? "")) continue;
        // Another of theirs that stays on and provides it keeps it there.
        if (all.some((p) => p.on && p.id && !gone.has(p.id) && p.provides?.includes(service))) continue;
        for (const p of all) {
          if (!p.id || !p.on || gone.has(p.id) || !p.services?.includes(service)) continue;
          gone.add(p.id);
          await setOn(folderOf(app, p), p.id, false);
          p.on = false;
          also.push(p);
          await off(p);
        }
      }
    };
    await off(plugin);
    return also;
  }

  /**
   * Adds files to an app's folder: plugins (.js) and the files they bring. Each plugin's manifest is
   * read first, and nothing is written if any is refused. A plugin that is added starts off.
   */
  async function add(app: string, files: File[], { quiet = false } = {}): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
    checkApp(app);
    if (!Array.isArray(files) || !files.length || files.length > 21) return { ok: false, error: "Add between 1 and 21 files" };
    const ids: string[] = [];
    /** A plugin is kept as <id>.js, whatever its file was called, so each id has one file. */
    const names = new Map<File, string>();
    for (const f of files) {
      if (!f || typeof f.name !== "string" || !FILE_PATH.test(f.name)) return { ok: false, error: `${f?.name}: a file name is letters, digits, ., - and _, in folders beside the plugin at most` };
      if (!(typeof f.data === "string" || f.data instanceof Blob)) return { ok: false, error: `${f.name}: no contents` };
      const size = typeof f.data === "string" ? f.data.length : f.data.size;
      if (size > MAX_BYTES) return { ok: false, error: `${f.name} is over 5 MB` };
      if (!isPlugin(f.name)) continue;
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
  }

  /**
   * A plugin's file and the files its manifest lists, read from this site, ready for add(): how the demos'
   * sample plugins are added, and how a person adds one they found elsewhere on the site.
   */
  async function fetchFiles(url: string): Promise<{ ok: true; files: File[]; source: string } | { ok: false; error: string }> {
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
      const files: File[] = [{ name: href.pathname.split("/").pop()!, data: source }];
      for (const name of manifest.files ?? []) files.push({ name, data: await get(new URL(name, href)) });
      return { ok: true, files, source };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The files one of the person's plugins keeps in a folder: its own, and the ones its manifest lists. */
  async function filesIn(folder: string, plugin: UserPlugin): Promise<string[]> {
    const source = (await store.readText(`user/${folder}/${plugin.file}`)) ?? "";
    let listed: string[] = [];
    try {
      listed = readManifest(source).files ?? [];
    } catch {}
    return [plugin.file, ...listed.filter((name) => FILE_PATH.test(name))];
  }

  /** Removes a plugin and the files its manifest lists, from the folder it is kept in. */
  async function remove(app: string, id: string, { quiet = false } = {}): Promise<boolean> {
    const plugin = (await list(app)).find((p) => p.id === id);
    if (!plugin) return false;
    const folder = folderOf(app, plugin);
    for (const name of await filesIn(folder, plugin)) await store.removeFile(`user/${folder}/${name}`);
    await setOn(folder, id, false);
    record({ kind: "lifecycle", name: "user-plugin:remove", plugin: id, detail: folder });
    if (!quiet) tell({ app: folder, removed: id });
    return true;
  }

  return {
    add,
    fetch: fetchFiles,
    remove,

    /**
     * Why one plugin's files can't go in an app's folder, if they can't: they are one plugin (.js), every
     * other file is one its manifest lists, and none belongs to another of the person's plugins there
     * (which it would overwrite). A review shows the plugin's code, so nothing else may ride along with it.
     */
    async problem(app: string, files: File[]): Promise<string | undefined> {
      const plugins = files.filter((f) => isPlugin(f.name));
      if (plugins.length !== 1 || typeof plugins[0].data !== "string") return "Add one plugin (.js) at a time, with the files its manifest lists";
      let manifest;
      try {
        manifest = readManifest(plugins[0].data);
      } catch (error) {
        return `${plugins[0].name}: ${error instanceof Error ? error.message : error}`;
      }
      const listed = new Set(manifest.files ?? []);
      const badName = files.find((f) => (f === plugins[0] ? !FILE_NAME.test(f.name) : !FILE_PATH.test(f.name)));
      if (badName) return `${badName.name}: a file name is letters, digits, ., - and _`;
      const extra = files.find((f) => f !== plugins[0] && !listed.has(f.name));
      if (extra) return `${extra.name} isn't one of the files ${manifest.id} lists`;
      const ours = new Set([`${manifest.id}.js`, ...listed]);
      // Only the plugins kept in this same folder can lose a file to it.
      for (const other of await list(app)) {
        if (!other.id || other.id === manifest.id || folderOf(app, other) !== app) continue;
        const clash = (await filesIn(app, other)).find((name) => ours.has(name));
        if (clash) return `${clash} belongs to ${other.name ?? other.id}, another plugin ${app === EVERYWHERE ? "you use in every app" : "for this app"}`;
      }
      return undefined;
    },

    async addFromUrl(app: string, url: string) {
      const fetched = await fetchFiles(url);
      return fetched.ok ? add(app, fetched.files) : fetched;
    },

    /**
     * Turns one of the person's plugins on, and with it the ones of theirs for the app that provide the
     * services it needs (and the ones those need), so turning on World clock turns on Clock too. A service
     * the kernel has already (`has`: a kernel module's, or a running plugin's) needs nothing turned on.
     * Each was reviewed when it was added, as turning one on needs no review. Returns the others it turned on.
     */
    async onWithNeeds(app: string, id: string, has: (service: string) => boolean, elsewhere: (service: string, not: string) => boolean = () => false): Promise<UserPlugin[]> {
      const all = await list(checkApp(app));
      const also: UserPlugin[] = [];
      const plugin = all.find((p) => p.id === id);
      // One provider of a service at a time: another of theirs that provides the same goes off, so the one
      // turned on last is the one that runs, rather than whichever happens to start first being refused. A
      // service only the one going off provided, which this one doesn't, takes the plugins that need it off too.
      for (const other of all) {
        if (!other.id || other.id === id || !other.on || !other.provides?.some((s) => plugin?.provides?.includes(s))) continue;
        await setOn(folderOf(app, other), other.id, false);
        other.on = false;
        await dropDependents(app, all, new Set([other.id, id]), { ...other, provides: other.provides.filter((s) => !plugin?.provides?.includes(s)) }, elsewhere);
      }
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
          await setOn(folderOf(app, provider), provider.id, true);
          also.push(provider);
          for (const name of provider.provides ?? []) covered.add(name);
          await visit(provider);
        }
      };
      await setOn(folderOf(app, plugin ?? {}), id, true);
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
      const plugin = all.find((p) => p.id === id);
      await setOn(folderOf(app, plugin ?? {}), id, false);
      return plugin ? dropDependents(app, all, new Set([id]), plugin, elsewhere) : [];
    },

    /**
     * Moves one of the person's plugins for an app to the folder for every app (`value` true), or one they
     * use everywhere back to this app alone, with its files, on as it was. Refused if its files would
     * overwrite another plugin's where it is going.
     */
    async everywhere(app: string, id: string, value: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
      checkApp(app);
      const plugin = (await list(app)).find((p) => p.id === id);
      if (!plugin) return { ok: false, error: `${id} isn't one of your plugins here` };
      if (!!plugin.everywhere === value) return { ok: true };
      const [from, to] = value ? [app, EVERYWHERE] : [EVERYWHERE, app];
      const names = await filesIn(from, plugin);
      const taken = new Set((await Promise.all((await list(to)).filter((p) => p.id !== id && folderOf(to, p) === to).map((p) => filesIn(to, p)))).flat());
      const clash = names.find((name) => taken.has(name));
      if (clash) return { ok: false, error: `${clash} belongs to another of your plugins ${value ? "for every app" : "for this app"}` };
      for (const name of names) {
        const bytes = await store.readBytes(`user/${from}/${name}`);
        if (bytes) await store.writeFile(`user/${to}/${name}`, new Blob([bytes as BlobPart]));
      }
      for (const name of names) await store.removeFile(`user/${from}/${name}`);
      await setOn(from, id, false);
      await setOn(to, id, plugin.on);
      record({ kind: "lifecycle", name: "user-plugin:everywhere", plugin: id, detail: `${from} to ${to}` });
      return { ok: true };
    },
  };
}
