// The `folder` service. A folder of files the person works on, such as a
// Hugo site: on their disk, if they pick one, or a private folder in the
// browser until they do. The Markdown editor (demos/markdown-editor/) keeps
// its posts here, and its extensions read the site through it.
// A kernel module (docs/layers.md): a site that lists `folder` in kernel.json has it, as `ctx.call("folder", …)`.
//
// The folder is a seam provider like the kernel's own (src/seams/opfs.ts):
// a FileSystemDirectoryHandle, picked in a tab with showDirectoryPicker (the
// `folder` bridge, src/host/bridges/folder.ts) and kept in IndexedDB so it is
// there after a reload. The browser asks the person again before a picked
// folder can be used in a new session; until then a call fails with
// "needs-permission", and `allow()` (after a click) asks them.
//
// Reading needs `folder:read`. Writing needs `folder:write`, for the plugin
// that keeps the folder's files, as the editor's document plugin does; it
// writes without asking, because the person typed what it saves. Any other
// plugin proposes a change with `folder:propose`, and the person reviews it
// as a diff first, as they do a write to another plugin's data. Picking the
// folder needs `folder:choose`.
//
// Each app has its own folder: the app a call comes from (the tab it was made
// in, or the tabs that have the plugin's app open) picks which, so the
// Markdown editor's site and another app's folder never mix. Before folders
// were per app there was one for the browser profile; the first app to use
// the service after that keeps it, picked folder and private files alike.
// Spaces' servers have none.

import { service, type ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";
import type { Dispatch } from "../../src/shared/protocol";

const DB = "ewa-folder";
/** Where the one folder for the whole profile was kept, before each app had its own. */
const OLD_KEY = "folder";
/** The app that took over that folder, and its private files. */
const OLD_OWNER = "old-folder-owner";
/** Each app's picked folder is kept under this and the app's name. */
const KEY = "app:";
/** The private folders used until the person picks one, in the browser's own storage. Hidden, so the files service can't reach them. */
const PRIVATE = ".folders";
/** The private folder from before folders were per app: the app that took it over still uses it. */
const OLD_PRIVATE = ".folder";
/** What a plugin no app links (one the workbench installed) uses as its app. */
const NO_APP = "~workbench";
/** An app's private folder's name: its folder, with ~ for / (an app folder's parts are letters, digits, _ and -, so no two apps share one). */
const privateName = (app: string) => app.replace(/\//g, "~");
const MAX_FILE = 5_000_000;
const MAX_LISTED = 5000;
/** Folders a listing never goes into: version control, dependencies and builds, which a site has plenty of. */
const SKIPPED = new Set(["node_modules", "public", "resources", "dist"]);

type Handle = FileSystemDirectoryHandle & {
  queryPermission?(o: { mode: string }): Promise<PermissionState>;
};

/** A path in the folder: relative, with no `..`, nothing in .git, no .env files, and no odd characters. A site's own settings (.editor/) are fine. */
function checkPath(path: unknown): string[] {
  if (typeof path !== "string" || !path || path.length > 512) throw new Error("A path is a non-empty string of at most 512 characters");
  if (path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f:*?"<>|]/.test(path)) throw new Error(`${path}: paths are relative and use /`);
  const parts = path.split("/");
  // In any case: on a disk that ignores case (macOS, Windows), .GIT is .git.
  if (parts.some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git" || p.toLowerCase().startsWith(".env"))) throw new Error(`${path}: no empty parts, .., .git or .env`);
  return parts;
}

const gone = (error: unknown) => ["NotFoundError", "TypeMismatchError"].includes((error as DOMException)?.name);

/** The one IndexedDB record that keeps the picked folder's handle. */
function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("handles", mode);
      const request = run(tx.objectStore("handles"));
      tx.oncomplete = () => (open.result.close(), resolve(request.result));
      tx.onerror = () => (open.result.close(), reject(tx.error));
    };
  });
}

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { hosts, reviewed, apps } = kernel;
  const inBrowser = typeof navigator !== "undefined" && !!navigator.storage?.getDirectory && typeof indexedDB !== "undefined";
  /** Each app's picked folder (null: none, the private one), once read from IndexedDB. */
  const picked = new Map<string, Handle | null>();
  /** The app that took over the profile's one folder from before folders were per app ("" if there was none). */
  let oldOwner: Promise<string> | undefined;

  /**
   * Settles, once, which app keeps the folder from before: the first to ask, if there was one. Its picked
   * folder moves to that app's key; its private files stay where they are, in OLD_PRIVATE.
   */
  const ownerOfOld = (app: string) =>
    (oldOwner ??= (async () => {
      const files = await (await navigator.storage.getDirectory()).getDirectoryHandle(OLD_PRIVATE).then(
        () => true,
        () => false,
      );
      // One readwrite transaction: IndexedDB runs them one at a time across every kernel on this
      // origin (a tab's own, a space's), so only one app ever takes the old folder over.
      return new Promise<string>((resolve, reject) => {
        const open = indexedDB.open(DB, 1);
        open.onupgradeneeded = () => open.result.createObjectStore("handles");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("handles", "readwrite");
          const store = tx.objectStore("handles");
          let owner = "";
          const known = store.get(OLD_OWNER);
          known.onsuccess = () => {
            if (typeof known.result === "string") {
              owner = known.result;
              return;
            }
            const old = store.get(OLD_KEY);
            old.onsuccess = () => {
              const handle = old.result as Handle | undefined;
              owner = handle || files ? app : "";
              if (handle) {
                store.put(handle, KEY + app);
                store.delete(OLD_KEY);
              }
              store.put(owner, OLD_OWNER);
            };
          };
          tx.oncomplete = () => (open.result.close(), resolve(owner));
          tx.onerror = () => (open.result.close(), reject(tx.error));
        };
      });
    })().catch((error) => {
      // Asked again next time, rather than remembering the failure.
      oldOwner = undefined;
      throw error;
    }));

  const remembered = async (app: string): Promise<Handle | null> => {
    const known = picked.get(app);
    if (known !== undefined) return known;
    await ownerOfOld(app);
    const handle = ((await idb("readonly", (s) => s.get(KEY + app)).catch(() => null)) as Handle | undefined) ?? null;
    picked.set(app, handle);
    return handle;
  };
  const privateFolder = async (app: string) => {
    const storage = await navigator.storage.getDirectory();
    if ((await ownerOfOld(app)) === app) return storage.getDirectoryHandle(OLD_PRIVATE, { create: true });
    return (await storage.getDirectoryHandle(PRIVATE, { create: true })).getDirectoryHandle(privateName(app), { create: true });
  };

  /** The app folder to use: the one picked, once the browser lets us, or the private one. */
  const root = async (app: string): Promise<Handle> => {
    if (!inBrowser) throw new Error("There is no folder here: the folder service runs in the browser, not on a space's server");
    const handle = await remembered(app);
    if (!handle) return privateFolder(app);
    const state = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
    if (state !== "granted") throw new Error(`needs-permission: the browser needs the person's go-ahead to open “${handle.name}” again (folder.allow, after a click)`);
    return handle;
  };

  const locate = async (app: string, path: string, create: boolean, base?: Handle) => {
    const parts = checkPath(path);
    const name = parts.pop()!;
    let at: FileSystemDirectoryHandle = base ?? (await root(app));
    for (const part of parts) at = await at.getDirectoryHandle(part, { create });
    return { at, name };
  };

  const read = async (app: string, path: string, base?: Handle): Promise<string | null> => {
    try {
      const { at, name } = await locate(app, path, false, base);
      const file = await (await at.getFileHandle(name)).getFile();
      if (file.size > MAX_FILE) throw new Error(`${path} is larger than 5 MB`);
      return await file.text();
    } catch (error) {
      if (gone(error)) return null;
      throw error;
    }
  };

  const write = async (app: string, path: string, text: string | Uint8Array, base?: Handle) => {
    const { at, name } = await locate(app, path, true, base);
    const writable = await (await at.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  };

  const list = async (app: string, prefix: string): Promise<string[]> => {
    const start = prefix ? checkPath(prefix.replace(/\/+$/, "")) : [];
    const out: string[] = [];
    let at: FileSystemDirectoryHandle = await root(app);
    try {
      for (const part of start) at = await at.getDirectoryHandle(part);
    } catch (error) {
      if (gone(error)) return [];
      throw error;
    }
    const walk = async (folder: FileSystemDirectoryHandle, path: string, depth: number) => {
      for await (const [name, handle] of (folder as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
        if (out.length >= MAX_LISTED) return;
        if (name.startsWith(".")) continue;
        const full = path ? `${path}/${name}` : name;
        if (handle.kind === "file") out.push(full);
        else if (depth < 10 && !SKIPPED.has(name)) await walk(handle as FileSystemDirectoryHandle, full, depth + 1);
      }
    };
    await walk(at, start.join("/"), 0);
    return out.sort();
  };

  /** What is in one folder: its files and folders, by name, folders first. */
  const entries = async (app: string, path: string) => {
    let at: FileSystemDirectoryHandle = await root(app);
    try {
      for (const part of path ? checkPath(path.replace(/\/+$/, "")) : []) at = await at.getDirectoryHandle(part);
    } catch (error) {
      if (gone(error)) return null;
      throw error;
    }
    const out: { name: string; kind: "file" | "directory" }[] = [];
    for await (const [name, handle] of (at as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (!name.startsWith(".") && out.length < MAX_LISTED) out.push({ name, kind: handle.kind });
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
  };

  const about = async (app: string) => {
    if (!inBrowser) return { name: null, picked: false, allowed: false };
    const handle = await remembered(app);
    if (!handle) return { name: "Private folder", picked: false, allowed: true };
    const state = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
    return { name: handle.name, picked: true, allowed: state === "granted" };
  };

  /**
   * The tab to ask in, for the picker: it must be the one the person clicked in. An action's trace starts
   * with the id of the tab it came from (src/host/main.ts), which a plugin shared by every tab needs;
   * otherwise the tab of a tab's own plugin, or the first tab with the plugin's app open.
   */
  const tabOf = (plugin: string, dispatch: Dispatch = {}) => {
    const from = dispatch.trace?.split("-")[0];
    const clicked = from && hosts.list.find((h) => h.tab === from);
    if (clicked) return clicked;
    const tab = plugin.split("@")[1];
    const id = plugin.split("@")[0];
    return hosts.list.find((h) => (tab ? h.tab === tab : kernel.apps.linkedBy(h.tab)?.includes(id)));
  };

  /**
   * The app a call is for: the app of the tab it was made in, if that app links the plugin, or else the
   * app of the plugin's own tab, or of the first tab whose app links it. A plugin no app links has the workbench's.
   */
  const appOf = (plugin: string, dispatch: Dispatch = {}) => {
    const [id, own] = plugin.split("@");
    const tabs = own ? [own] : apps.tabsWith(id);
    const from = dispatch.trace?.split("-")[0];
    const tab = from && tabs.includes(from) ? from : tabs[0];
    return (tab && kernel.appIn(tab)) || NO_APP;
  };

  /** A file's bytes from a data: URL (base64), at most MAX_FILE of them. */
  const bytes = (value: unknown) => {
    const match = typeof value === "string" ? /^data:[\w.+-]+\/[\w.+-]+(;[\w-]+=[\w.-]+)*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value) : null;
    if (!match) throw new Error("folder.writeData takes the file as a base64 data: URL");
    if ((match[2].length * 3) / 4 > MAX_FILE) throw new Error("The file is too large");
    const binary = atob(match[2]);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  };

  const text = (value: unknown, method: string) => {
    if (typeof value !== "string") throw new Error(`folder.${method} takes the file's whole text as a string`);
    if (value.length > MAX_FILE) throw new Error("The file is too large");
    return value;
  };

  return {
    description:
      "A folder of files the person works on, such as a Hugo site: one they picked on their disk, or a private folder in the browser until they do. Paths are relative, with /, and never reach .git or .env files.",
    methods: {
      about: { args: "()", params: [], returns: "{ name, picked, allowed }", needs: "folder:read", description: "The folder's name, whether the person picked it (or it is the private one), and whether the browser lets it be used now." },
      list: { args: "(prefix?)", params: [{ name: "prefix", schema: { type: "string", description: "A folder, such as content/posts; leave out for every file" }, optional: true }], returns: "[path]", needs: "folder:read", description: "Every file's path under prefix (all of them if left out), sorted, at most 5000. Hidden files, node_modules, public, resources and dist are left out." },
      entries: { args: "(path?)", params: [{ name: "path", schema: { type: "string", description: "A folder; leave out for the top" }, optional: true }], returns: "[{ name, kind }] or null", needs: "folder:read", description: "What is in one folder (the top if left out): each file's and folder's name, and kind \"file\" or \"directory\", folders first. null if there is no such folder. Hidden names are left out." },
      read: { args: "(path)", params: [{ name: "path", schema: { type: "string", description: "Relative to the folder, with /" } }], returns: "text or null", needs: "folder:read", description: "A file's text, or null if there is no such file. At most 5 MB." },
      write: { args: "(path, text)", params: [{ name: "path", schema: { type: "string", description: "Relative to the folder, with /" } }, { name: "text", schema: { type: "string", description: "The file's whole text" } }], returns: "{ ok, path }", needs: "folder:write", description: "Writes a file, making its folders. For the plugin that keeps the folder's files: it doesn't ask the person." },
      writeData: {
        args: "(path, dataUrl)",
        params: [
          { name: "path", schema: { type: "string", description: "Relative to the folder, with /" } },
          { name: "dataUrl", schema: { type: "string", description: "The file's bytes, as a base64 data: URL" } },
        ],
        returns: "{ ok, path }",
        needs: "folder:write",
        description: "Writes a file that isn't text, such as an image the person dropped, from a data: URL; at most 5 MB. As write, it doesn't ask the person.",
      },
      exists: { args: "(path)", params: [{ name: "path", schema: { type: "string", description: "Relative to the folder, with /" } }], returns: "true or false", needs: "folder:read", description: "Whether there is a file at path, whatever is in it (an image, say)." },
      propose: {
        args: "(path, text, reason)",
        params: [
          { name: "path", schema: { type: "string", description: "Relative to the folder, with /" } },
          { name: "text", schema: { type: "string", description: "The file's whole new text" } },
          { name: "reason", schema: { type: "string", description: "Why, for the person reviewing it" } },
        ],
        returns: "{ ok, path, outcome } or { ok, unchanged }",
        needs: "folder:propose",
        reviewed: true,
        description: "Asks the person to let a file be written: they see the change as a diff, with the reason, and allow it once, always for this plugin, or not. Fails if they decline or nobody answers.",
      },
      choose: { args: "()", returns: "{ name } or null", needs: "folder:choose", description: "Asks the person to pick a folder on their disk (right after a click in the app). null if they cancel. The files are left where they are." },
      allow: { args: "()", returns: "{ name, allowed }", needs: "folder:choose", description: "Asks the browser to let the picked folder be used again, after a reload (right after a click)." },
      forget: { args: "()", returns: "true", needs: "folder:choose", description: "Goes back to the private folder. The picked folder's files are left as they are." },
    },
    capability: (method) => (method === "write" || method === "writeData" ? "folder:write" : method === "propose" ? "folder:propose" : method === "choose" || method === "allow" || method === "forget" ? "folder:choose" : "folder:read"),
    async call(plugin, method, args, dispatch) {
      const app = appOf(plugin, dispatch);
      switch (method) {
        case "about":
          return about(app);
        case "list":
          return list(app, args[0] === undefined ? "" : String(args[0]));
        case "entries":
          return entries(app, args[0] === undefined ? "" : String(args[0]));
        case "read":
          return read(app, String(args[0]));
        case "exists":
          try {
            const { at, name } = await locate(app, String(args[0]), false);
            await at.getFileHandle(name);
            return true;
          } catch (error) {
            if (gone(error)) return false;
            throw error;
          }
        case "write": {
          const path = checkPath(args[0]).join("/");
          await write(app, path, text(args[1], "write"));
          return { ok: true, path };
        }
        case "writeData": {
          const path = checkPath(args[0]).join("/");
          await write(app, path, bytes(args[1]));
          return { ok: true, path };
        }
        case "propose": {
          const path = checkPath(args[0]).join("/");
          const after = text(args[1], "propose");
          // The folder the person reviews the change in is the one it is written to.
          const base = await root(app);
          const before = await read(app, path, base);
          if (before === after) return { ok: true, unchanged: true };
          const outcome = await reviewed(plugin, `folder:${path.split("/")[0]}`, path, before ?? "", after, args[2], dispatch);
          if (!(await base.isSameEntry(await root(app)))) throw new Error(`Another folder was picked while the review of ${path} was open`);
          // Written only if the file is still what the person reviewed.
          if ((await read(app, path, base)) !== before) throw new Error(`${path} changed while the review was open`);
          await write(app, path, after, base);
          return { ok: true, path, outcome };
        }
        case "choose": {
          if (!inBrowser) throw new Error("There is no folder to pick on a space's server");
          const host = tabOf(plugin, dispatch);
          if (!host) throw new Error("No tab has this plugin's app open");
          const handle = (await hosts.bridge("folder", "pick", [], dispatch, host)) as Handle | null;
          if (!handle) return null;
          await ownerOfOld(app);
          await idb("readwrite", (s) => s.put(handle, KEY + app));
          picked.set(app, handle);
          return { name: handle.name };
        }
        case "allow": {
          const handle = await remembered(app);
          if (!handle) return { name: "Private folder", allowed: true };
          const host = tabOf(plugin, dispatch);
          if (!host) throw new Error("No tab has this plugin's app open");
          const allowed = (await hosts.bridge("folder", "allow", [handle], dispatch, host)) === true;
          return { name: handle.name, allowed };
        }
        case "forget":
          await ownerOfOld(app);
          await idb("readwrite", (s) => s.delete(KEY + app));
          picked.set(app, null);
          return true;
      }
      throw new Error(`folder.${method} is not a method`);
    },
  };
};

export default service("folder", make);
