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
// There is one folder for the browser profile, as the editor has one open
// site. Spaces' servers have none.

import { service, type ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";

const DB = "ewa-folder";
const KEY = "folder";
/** The private folder used until the person picks one, in the browser's own storage. Hidden, so the files service can't reach it. */
const PRIVATE = ".folder";
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
  if (parts.some((p) => !p || p === "." || p === ".." || p === ".git" || p.startsWith(".env"))) throw new Error(`${path}: no empty parts, .., .git or .env`);
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
  const { hosts, reviewed } = kernel;
  const inBrowser = typeof navigator !== "undefined" && !!navigator.storage?.getDirectory && typeof indexedDB !== "undefined";
  let picked: Handle | null | undefined;

  const remembered = async (): Promise<Handle | null> => {
    if (picked !== undefined) return picked;
    picked = ((await idb("readonly", (s) => s.get(KEY)).catch(() => null)) as Handle | undefined) ?? null;
    return picked;
  };
  const privateFolder = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(PRIVATE, { create: true });

  /** The folder to use: the one picked, once the browser lets us, or the private one. */
  const root = async (): Promise<Handle> => {
    if (!inBrowser) throw new Error("There is no folder here: the folder service runs in the browser, not on a space's server");
    const handle = await remembered();
    if (!handle) return privateFolder();
    const state = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
    if (state !== "granted") throw new Error(`needs-permission: the browser needs the person's go-ahead to open “${handle.name}” again (folder.allow, after a click)`);
    return handle;
  };

  const locate = async (path: string, create: boolean) => {
    const parts = checkPath(path);
    const name = parts.pop()!;
    let at: FileSystemDirectoryHandle = await root();
    for (const part of parts) at = await at.getDirectoryHandle(part, { create });
    return { at, name };
  };

  const read = async (path: string): Promise<string | null> => {
    try {
      const { at, name } = await locate(path, false);
      const file = await (await at.getFileHandle(name)).getFile();
      if (file.size > MAX_FILE) throw new Error(`${path} is larger than 5 MB`);
      return await file.text();
    } catch (error) {
      if (gone(error)) return null;
      throw error;
    }
  };

  const write = async (path: string, text: string) => {
    const { at, name } = await locate(path, true);
    const writable = await (await at.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  };

  const list = async (prefix: string): Promise<string[]> => {
    const start = prefix ? checkPath(prefix.replace(/\/+$/, "")) : [];
    const out: string[] = [];
    let at: FileSystemDirectoryHandle = await root();
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
  const entries = async (path: string) => {
    let at: FileSystemDirectoryHandle = await root();
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

  const about = async () => {
    if (!inBrowser) return { name: null, picked: false, allowed: false };
    const handle = await remembered();
    if (!handle) return { name: "Private folder", picked: false, allowed: true };
    const state = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
    return { name: handle.name, picked: true, allowed: state === "granted" };
  };

  /** The tab the asking plugin's app is open in, for the picker: it must be the one the person clicked in. */
  const tabOf = (plugin: string) => {
    const tab = plugin.split("@")[1];
    const id = plugin.split("@")[0];
    return hosts.list.find((h) => (tab ? h.tab === tab : kernel.apps.linkedBy(h.tab)?.includes(id)));
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
      about: { args: "()", returns: "{ name, picked, allowed }", needs: "folder:read", description: "The folder's name, whether the person picked it (or it is the private one), and whether the browser lets it be used now." },
      list: { args: "(prefix?)", returns: "[path]", needs: "folder:read", description: "Every file's path under prefix (all of them if left out), sorted, at most 5000. Hidden files, node_modules, public, resources and dist are left out." },
      entries: { args: "(path?)", returns: "[{ name, kind }] or null", needs: "folder:read", description: "What is in one folder (the top if left out): each file's and folder's name, and kind \"file\" or \"directory\", folders first. null if there is no such folder. Hidden names are left out." },
      read: { args: "(path)", returns: "text or null", needs: "folder:read", description: "A file's text, or null if there is no such file. At most 5 MB." },
      write: { args: "(path, text)", returns: "{ ok, path }", needs: "folder:write", description: "Writes a file, making its folders. For the plugin that keeps the folder's files: it doesn't ask the person." },
      propose: {
        args: "(path, text, reason)",
        returns: "{ ok, path, outcome } or { ok, unchanged }",
        needs: "folder:propose",
        reviewed: true,
        description: "Asks the person to let a file be written: they see the change as a diff, with the reason, and allow it once, always for this plugin, or not. Fails if they decline or nobody answers.",
      },
      choose: { args: "()", returns: "{ name } or null", needs: "folder:choose", description: "Asks the person to pick a folder on their disk (right after a click in the app). null if they cancel. The files are left where they are." },
      allow: { args: "()", returns: "{ name, allowed }", needs: "folder:choose", description: "Asks the browser to let the picked folder be used again, after a reload (right after a click)." },
      forget: { args: "()", returns: "true", needs: "folder:choose", description: "Goes back to the private folder. The picked folder's files are left as they are." },
    },
    capability: (method) => (method === "write" ? "folder:write" : method === "propose" ? "folder:propose" : method === "choose" || method === "allow" || method === "forget" ? "folder:choose" : "folder:read"),
    async call(plugin, method, args, dispatch) {
      switch (method) {
        case "about":
          return about();
        case "list":
          return list(args[0] === undefined ? "" : String(args[0]));
        case "entries":
          return entries(args[0] === undefined ? "" : String(args[0]));
        case "read":
          return read(String(args[0]));
        case "write": {
          const path = checkPath(args[0]).join("/");
          await write(path, text(args[1], "write"));
          return { ok: true, path };
        }
        case "propose": {
          const path = checkPath(args[0]).join("/");
          const after = text(args[1], "propose");
          const before = await read(path);
          if (before === after) return { ok: true, unchanged: true };
          const outcome = await reviewed(plugin, `folder:${path.split("/")[0]}`, path, before ?? "", after, args[2], dispatch);
          // Written only if the file is still what the person reviewed.
          if ((await read(path)) !== before) throw new Error(`${path} changed while the review was open`);
          await write(path, after);
          return { ok: true, path, outcome };
        }
        case "choose": {
          if (!inBrowser) throw new Error("There is no folder to pick on a space's server");
          const host = tabOf(plugin);
          if (!host) throw new Error("No tab has this plugin's app open");
          const handle = (await hosts.bridge("folder", "pick", [], dispatch, host)) as Handle | null;
          if (!handle) return null;
          await idb("readwrite", (s) => s.put(handle, KEY));
          picked = handle;
          return { name: handle.name };
        }
        case "allow": {
          const handle = await remembered();
          if (!handle) return { name: "Private folder", allowed: true };
          const host = tabOf(plugin);
          if (!host) throw new Error("No tab has this plugin's app open");
          const allowed = (await hosts.bridge("folder", "allow", [handle], dispatch, host)) === true;
          return { name: handle.name, allowed };
        }
        case "forget":
          await idb("readwrite", (s) => s.delete(KEY));
          picked = null;
          return true;
      }
      throw new Error(`folder.${method} is not a method`);
    },
  };
};

export default service("folder", make);
