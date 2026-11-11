// Changes to the plugins a person added to an app (user-plugins.ts): adding
// one with the files it lists, verifying content-addressed registry integrity,
// tracking installed package metadata for permission-diff updates, removing it,
// turning it on with the plugins of theirs that provide what it needs, turning
// it off with the ones that need it, moving one between an app's folder and the
// folder for every app, and exporting/restoring full local device OPFS backups.
//
// An app that opens only needs to know which of the person's plugins to
// start, so that part is user-plugins.ts, in the kernel's own file. This
// part is fetched the first time something changes: the person opens
// Customize, a plugin they made is saved, a space sends a shared one.

import { checkPath } from "../seams/index";
import { isAgentFile } from "../shared/agent-runner";
import { FILE_PATH, readManifest } from "./manifest";
import { asMove, type Moved } from "./moves";
import type { RemotePlugins } from "./remote";
import type { Store } from "./store";
import { record } from "./trace";
import { checkApp, EVERYWHERE, folderOf, type UserPlugin, type UserPlugins } from "./user-plugins";

const FILE_NAME = /^[\w-][\w.-]{0,63}$/;
/** A plugin is a .js file at the top of the app's folder, or an agent's .agent.md; a .js file in a folder below it is one of a plugin's files, such as a template. */
const isPlugin = (name: string) => (name.endsWith(".js") || isAgentFile(name)) && !name.includes("/");
/** The name one is kept under: its id, so each id has one file. */
const keptAs = (id: string, name: string) => `${id}${isAgentFile(name) ? ".agent.md" : ".js"}`;
/** The file the same id would be kept under as the other kind: an id is a plugin or an agent, not both. */
const otherForm = (name: string) => (name.endsWith(".js") ? name.replace(/\.js$/, ".agent.md") : name.replace(/\.agent\.md$/, ".js"));
const MAX_BYTES = 5_000_000;
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
export const USER_PACKAGES_META = "user/packages.json";
export const BACKUP_FORMAT = "extensible-web-apps/backup";
export const BACKUP_ROOT_FILES = ["plugins.json", "user-plugins.json", "grants.json", "moves.json", "llm.json"] as const;
export const BACKUP_FOLDERS = ["collections", "plugins", "plugin-data", "user", "moves"] as const;

type File = { name: string; data: Blob | string };

export interface InstalledPackageMeta {
  integrity: string;
  version?: string;
  href?: string;
}

export interface ProfileBackup {
  ok?: true;
  format: typeof BACKUP_FORMAT;
  version: 1;
  exportedAt: string;
  summary: {
    collections: string[];
    plugins: string[];
    files: number;
  };
  files: Record<string, { text?: string; base64?: string } | string>;
}

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A file's bytes as UTF-8 text when they round-trip losslessly, or undefined for binary files. */
const asText = (bytes: Uint8Array): string | undefined => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const again = new TextEncoder().encode(text);
    return again.length === bytes.length && again.every((b, i) => b === bytes[i]) ? text : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Content-addressed SHA-256 integrity ("sha256-<base64>") over a plugin's source and any
 * accompanying files listed in manifest.files, matching scripts/packages.mjs byte-for-byte.
 */
export async function computeIntegrity(source: string, companions: { name: string; data: Blob | string | Uint8Array }[] = []): Promise<string> {
  const enc = new TextEncoder();
  const main = enc.encode(source);
  if (!companions.length) {
    const digest = await crypto.subtle.digest("SHA-256", main);
    return `sha256-${toBase64(new Uint8Array(digest))}`;
  }
  const sorted = [...companions].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Uint8Array[] = [main];
  for (const f of sorted) {
    const bytes = f.data instanceof Uint8Array ? f.data : typeof f.data === "string" ? enc.encode(f.data) : new Uint8Array(await f.data.arrayBuffer());
    parts.push(enc.encode(`\0${f.name}\0${bytes.byteLength}\n`), bytes);
  }
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    joined.set(p, offset);
    offset += p.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", joined);
  return `sha256-${toBase64(new Uint8Array(digest))}`;
}

export async function readPackageMeta(store: Store): Promise<Record<string, InstalledPackageMeta>> {
  const raw = await store.readJson<unknown>(USER_PACKAGES_META, {});
  const out: Record<string, InstalledPackageMeta> = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const v = val as Record<string, unknown>;
    if (typeof v.integrity === "string") {
      out[key] = {
        integrity: v.integrity,
        ...(typeof v.version === "string" && v.version ? { version: v.version } : {}),
        ...(typeof v.href === "string" && v.href ? { href: v.href } : {}),
      };
    }
  }
  return out;
}

async function writePackageMeta(store: Store, meta: Record<string, InstalledPackageMeta>): Promise<void> {
  await store.writeJson(USER_PACKAGES_META, meta);
}

/**
 * Returns the installed integrity and version for a user plugin in `folder`, reading `user/packages.json`
 * first and computing on the fly from OPFS files when metadata wasn't recorded yet.
 */
export async function installedPackageInfo(
  store: Store,
  folder: string,
  plugin: UserPlugin,
  savedMeta?: Record<string, InstalledPackageMeta>,
): Promise<InstalledPackageMeta> {
  const meta = savedMeta ?? (await readPackageMeta(store));
  const key = plugin.id ? `${folder}/${plugin.id}` : "";
  if (key && meta[key]) return meta[key];
  const source = (await store.readText(`user/${folder}/${plugin.file}`)) ?? "";
  let version: string | undefined;
  let listed: string[] = [];
  if (!isAgentFile(plugin.file)) {
    try {
      const m = readManifest(source);
      version = m.version;
      listed = (m.files ?? []).filter((name) => FILE_PATH.test(name));
    } catch {}
  }
  const companions: { name: string; data: Uint8Array }[] = [];
  for (const name of listed) {
    const bytes = await store.readBytes(`user/${folder}/${name}`);
    companions.push({ name, data: bytes ?? new Uint8Array(0) });
  }
  const integrity = await computeIntegrity(source, companions);
  return { integrity, ...(version ? { version } : {}) };
}

/** Validates every path in a local profile backup archive, strictly refusing secrets.json, sync/, and traversal. */
export function validateBackupPath(rawPath: unknown): string {
  if (typeof rawPath !== "string") throw new Error("Backup file path must be a string");
  const path = checkPath(rawPath);
  if (path === "secrets.json" || path.startsWith("secrets/") || path === "sync" || path.startsWith("sync/")) {
    throw new Error(`Backup cannot include protected path: ${path}`);
  }
  if (/[\u0000-\u001f:*?"<>|]/.test(path)) throw new Error(`Backup path has invalid characters: ${path}`);
  const parts = path.split("/");
  if (parts.some((p) => p.startsWith("."))) throw new Error(`Backup cannot include hidden path: ${path}`);
  if (parts.length === 1) {
    if (!(BACKUP_ROOT_FILES as readonly string[]).includes(parts[0])) throw new Error(`Unsupported root file in backup: ${path}`);
    return path;
  }
  if (!(BACKUP_FOLDERS as readonly string[]).includes(parts[0])) throw new Error(`Unsupported folder in backup: ${path}`);
  return path;
}

/** Exports the entire local device OPFS profile, strictly excluding secrets.json and sync/ session marks. */
export async function backupProfile(store: Store): Promise<ProfileBackup & { ok: true }> {
  const files: Record<string, { text?: string; base64?: string }> = {};
  const paths = new Set<string>();
  for (const folder of BACKUP_FOLDERS) {
    for (const path of await store.listAll(folder).catch(() => [])) paths.add(path);
  }
  for (const rootFile of BACKUP_ROOT_FILES) {
    if ((await store.readBytes(rootFile)) !== undefined) paths.add(rootFile);
  }
  for (const path of [...paths].sort()) {
    if (path === "secrets.json" || path.startsWith("secrets/") || path === "sync" || path.startsWith("sync/")) continue;
    const parts = path.split("/");
    if (parts.some((p) => !p || p.startsWith("."))) continue;
    const bytes = await store.readBytes(path);
    if (!bytes) continue;
    const text = asText(bytes);
    files[path] = text !== undefined ? { text } : { base64: toBase64(bytes) };
  }
  const collections = Object.keys(files)
    .filter((p) => p.startsWith("collections/") && p.endsWith(".json") && p !== "collections/_registry.json")
    .map((p) => p.slice("collections/".length, -".json".length));
  const plugins = new Set<string>();
  for (const [path, entry] of Object.entries(files)) {
    const text = typeof entry.text === "string" ? entry.text : undefined;
    if (!text) continue;
    if (path.startsWith("plugins/") && path.endsWith(".js") && path.split("/").length === 2) {
      try {
        plugins.add(readManifest(text).id);
      } catch {}
    } else if (path.startsWith("user/")) {
      const file = path.split("/").pop() ?? "";
      const rel = path.slice("user/".length);
      if (rel.includes("/") && (file.endsWith(".js") || isAgentFile(file)) && !rel.slice(rel.lastIndexOf("/") + 1).includes("/")) {
        plugins.add(file.replace(/\.(?:agent\.md|js)$/, ""));
      }
    }
  }
  return {
    ok: true,
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    summary: {
      collections: collections.sort(),
      plugins: [...plugins].sort(),
      files: Object.keys(files).length,
    },
    files,
  };
}

/** Validates, reviews on a single card, and restores a local device OPFS profile backup. */
export async function restoreProfile(
  rawArchive: unknown,
  deps: {
    store: Store;
    userAdded: UserPlugins;
    remote: RemotePlugins;
    reopen: (app: string) => Promise<void>;
    askReview: (target: string, before: string, after: string, reason: string) => Promise<boolean>;
    move?: (app: string, plugin: string, place: string, to: Moved | null) => Promise<void>;
    syncGrants?: (grants: Record<string, string[]>) => Promise<void>;
  },
): Promise<{ ok: true; collections: string[]; plugins: string[]; files: number } | { ok: false; error: string }> {
  let parsed: unknown = rawArchive;
  if (typeof rawArchive === "string") {
    try {
      parsed = JSON.parse(rawArchive);
    } catch {
      return { ok: false, error: "Backup file isn't valid JSON" };
    }
  }
  const archive = parsed as Partial<ProfileBackup> | null;
  if (!archive || typeof archive !== "object" || Array.isArray(archive) || archive.format !== BACKUP_FORMAT) {
    return { ok: false, error: "That isn't a local profile backup archive" };
  }
  if (archive.version !== 1) {
    return { ok: false, error: `Unsupported backup version: ${String(archive.version)}` };
  }
  if (!archive.files || typeof archive.files !== "object" || Array.isArray(archive.files)) {
    return { ok: false, error: "Backup archive has no files map" };
  }

  const enc = new TextEncoder();
  const decoded: { path: string; text?: string; bytes: Uint8Array }[] = [];
  let totalBytes = 0;
  try {
    for (const [rawPath, entry] of Object.entries(archive.files)) {
      const path = validateBackupPath(rawPath);
      let bytes: Uint8Array;
      let text: string | undefined;
      if (typeof entry === "string") {
        text = entry;
        bytes = enc.encode(entry);
      } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        if (typeof entry.text === "string") {
          text = entry.text;
          bytes = enc.encode(entry.text);
        } else if (typeof entry.base64 === "string") {
          if (entry.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.base64)) {
            return { ok: false, error: `Backup entry ${path} isn't valid base64` };
          }
          bytes = fromBase64(entry.base64);
          text = asText(bytes);
        } else {
          return { ok: false, error: `Backup entry ${path} has no contents` };
        }
      } else {
        return { ok: false, error: `Backup entry ${path} is malformed` };
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_BACKUP_BYTES) return { ok: false, error: "Backup archive exceeds the 20 MB limit" };
      decoded.push({ path, text, bytes });
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  decoded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byPath = new Map(decoded.map((d) => [d.path, d]));

  // Parse collection & plugin summaries (and reject malformed plugin manifests before any review/write).
  let registryMeta: Record<string, { owner?: string; title?: string; schema?: unknown }> = {};
  const regEntry = byPath.get("collections/_registry.json");
  if (regEntry?.text) {
    try {
      const p = JSON.parse(regEntry.text);
      if (p && typeof p === "object" && !Array.isArray(p)) registryMeta = p;
    } catch {
      return { ok: false, error: "collections/_registry.json in backup isn't valid JSON" };
    }
  }

  const collectionLines: string[] = [];
  const collectionIds: string[] = [];
  const parsedCollections = new Map<string, Record<string, Record<string, unknown>>>();
  for (const item of decoded) {
    if (!item.path.startsWith("collections/") || !item.path.endsWith(".json") || item.path === "collections/_registry.json") continue;
    const name = item.path.slice("collections/".length, -".json".length);
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(name) || item.text === undefined) return { ok: false, error: `Invalid collection file in backup: ${item.path}` };
    let recordsObj: unknown;
    try {
      recordsObj = JSON.parse(item.text);
    } catch {
      return { ok: false, error: `${item.path} in backup isn't valid JSON` };
    }
    if (!recordsObj || typeof recordsObj !== "object" || Array.isArray(recordsObj)) return { ok: false, error: `${item.path} must be a record map` };
    const map = recordsObj as Record<string, Record<string, unknown>>;
    parsedCollections.set(name, map);
    collectionIds.push(name);
    const count = Object.keys(map).length;
    const title = typeof registryMeta[name]?.title === "string" ? registryMeta[name].title! : name;
    collectionLines.push(`collection ${title} (${name}): ${count} record${count === 1 ? "" : "s"}`);
  }

  const pluginLines: string[] = [];
  const pluginIds: string[] = [];
  for (const item of decoded) {
    if (item.path.startsWith("plugins/") && item.path.endsWith(".js") && item.path.split("/").length === 2) {
      if (item.text === undefined) return { ok: false, error: `Invalid plugin file: ${item.path}` };
      try {
        const m = readManifest(item.text);
        pluginIds.push(m.id);
        pluginLines.push(`plugin ${m.name} (${m.id}, data): ${m.permissions.length ? m.permissions.join(", ") : "no permissions"}`);
      } catch (error) {
        return { ok: false, error: `${item.path}: ${error instanceof Error ? error.message : String(error)}` };
      }
    } else if (item.path.startsWith("user/")) {
      const rest = item.path.slice("user/".length);
      const slash = rest.lastIndexOf("/");
      if (slash < 1) continue;
      const folder = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      // Companion sub-folders (like elements/ or templates/) are not top-level user plugin files.
      if (folder.endsWith("/elements") || folder.includes(".")) continue;
      if (!(file.endsWith(".js") || isAgentFile(file))) continue;
      if (item.text === undefined) return { ok: false, error: `Invalid user plugin file: ${item.path}` };
      try {
        const m = await deps.userAdded.manifest(file, item.text);
        pluginIds.push(m.id);
        pluginLines.push(`plugin ${m.name} (${m.id} in ${folder}): ${m.permissions.length ? m.permissions.join(", ") : "no permissions"}`);
      } catch (error) {
        return { ok: false, error: `${item.path}: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  }

  const currentBackup = await backupProfile(deps.store);
  const beforeLines = [
    ...currentBackup.summary.collections.map((c) => `collection ${c}`),
    ...currentBackup.summary.plugins.map((p) => `plugin ${p}`),
    ...Object.keys(currentBackup.files).map((p) => `file ${p}`),
  ];
  const afterLines = [
    ...collectionLines,
    ...pluginLines,
    ...decoded.map((d) => `file ${d.path}`),
  ];

  const target = `this device: restores backup (${collectionIds.length} collection${collectionIds.length === 1 ? "" : "s"}, ${pluginIds.length} plugin${pluginIds.length === 1 ? "" : "s"})`;
  const summaryParts: string[] = [`Restores ${decoded.length} file${decoded.length === 1 ? "" : "s"} on this device.`];
  if (collectionLines.length) summaryParts.push(`Collections: ${collectionLines.map((l) => l.replace(/^collection /, "")).join(", ")}.`);
  if (pluginLines.length) summaryParts.push(`Plugins: ${pluginLines.map((l) => l.replace(/^plugin /, "")).join("; ")}.`);
  summaryParts.push("API keys on this device are kept untouched.");

  const accepted = await deps.askReview(target, beforeLines.join("\n"), afterLines.join("\n"), summaryParts.join(" "));
  if (!accepted) return { ok: false, error: "Not restored" };

  // Clear existing user-plugin `on` state before replacing files so userAdded's in-memory state stays exact.
  const previousOn = await deps.store.readJson<Record<string, unknown>>("user-plugins.json", {});
  for (const [folder, ids] of Object.entries(previousOn ?? {})) {
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === "string") await deps.userAdded.mark(folder, id, false).catch(() => {});
    }
  }

  // Remove stale files in backup folders/root files that aren't in the restored archive (leaving secrets.json & sync/ untouched).
  for (const path of Object.keys(currentBackup.files)) {
    if (!byPath.has(path)) await deps.store.removeFile(path).catch(() => {});
  }

  // Write all restored files to OPFS.
  for (const item of decoded) {
    if (item.text !== undefined) await deps.store.writeText(item.path, item.text);
    else await deps.store.writeFile(item.path, new Blob([item.bytes as BlobPart]));
  }

  // Sync user-plugins.json in-memory state in userAdded.
  const nextOnEntry = byPath.get("user-plugins.json");
  if (nextOnEntry?.text) {
    try {
      const nextOn = JSON.parse(nextOnEntry.text) as Record<string, unknown>;
      if (nextOn && typeof nextOn === "object" && !Array.isArray(nextOn)) {
        for (const [folder, ids] of Object.entries(nextOn)) {
          if (!Array.isArray(ids)) continue;
          for (const id of ids) {
            if (typeof id === "string") await deps.userAdded.mark(folder, id, true).catch(() => {});
          }
        }
      }
    } catch {}
  }

  // Sync collections registry & any live in-memory collections so open bound views update immediately.
  for (const [name, spec] of Object.entries(registryMeta)) {
    if (spec && typeof spec === "object" && typeof spec.owner === "string" && spec.schema && typeof spec.schema === "object") {
      deps.remote.onManifest?.({
        id: spec.owner,
        name: spec.owner,
        permissions: [],
        collections: { [name]: { title: typeof spec.title === "string" ? spec.title : name, schema: spec.schema } },
      });
    }
  }
  const dataService = deps.remote.services.data;
  if (dataService) {
    const known = ((await dataService.call("", "collections", [], {})) as { name: string; owner: string }[] | undefined) ?? [];
    for (const c of known) {
      if (!deps.remote.installed.has(c.owner)) continue;
      const targetMap = parsedCollections.get(c.name) ?? {};
      const live = ((await dataService.call(c.owner, "list", [c.name], {})) as { id: string }[] | undefined) ?? [];
      for (const rec of live) {
        if (!Object.hasOwn(targetMap, rec.id)) await Promise.resolve(dataService.call(c.owner, "delete", [c.name, rec.id], {})).catch(() => {});
      }
      for (const [id, rec] of Object.entries(targetMap)) {
        if (rec && typeof rec === "object") await Promise.resolve(dataService.call(c.owner, "put", [c.name, { ...rec, id }], {})).catch(() => {});
      }
      const exact = byPath.get(`collections/${c.name}.json`);
      if (exact?.text !== undefined) await deps.store.writeText(`collections/${c.name}.json`, exact.text);
      else if (!parsedCollections.has(c.name)) await deps.store.removeFile(`collections/${c.name}.json`).catch(() => {});
    }
  }

  // Sync runtime data plugins (plugins/*.js).
  for (const [id, installed] of [...deps.remote.installed.entries()]) {
    if (installed.origin === "data" && !byPath.has(`plugins/${id}.js`)) deps.remote.uninstall(id);
  }
  for (const item of decoded) {
    if (item.path.startsWith("plugins/") && item.path.endsWith(".js") && item.path.split("/").length === 2 && item.text !== undefined) {
      await deps.remote.install(item.text, { origin: "data" }).catch(() => {});
    }
  }

  // Sync moves if move callback is available.
  if (deps.move) {
    for (const item of decoded) {
      if (!item.path.startsWith("moves/") || !item.path.endsWith(".json") || item.text === undefined) continue;
      const app = item.path.slice("moves/".length, -".json".length).replace(/~/g, "/");
      try {
        const parsedMoves = JSON.parse(item.text) as Record<string, Record<string, unknown>>;
        for (const [plugin, places] of Object.entries(parsedMoves ?? {})) {
          for (const [place, to] of Object.entries(places ?? {})) {
            const m = asMove(to);
            if (m) await deps.move(app, plugin, place, m).catch(() => {});
          }
        }
      } catch {}
    }
  }

  // Sync grants if syncGrants callback is available.
  if (deps.syncGrants) {
    const grantsEntry = byPath.get("grants.json");
    const restoredGrants: Record<string, string[]> = {};
    if (grantsEntry?.text) {
      try {
        const g = JSON.parse(grantsEntry.text);
        if (g && typeof g === "object" && !Array.isArray(g)) {
          for (const [plugin, list] of Object.entries(g)) {
            if (Array.isArray(list)) restoredGrants[plugin] = list.filter((p): p is string => typeof p === "string");
          }
        }
      } catch {}
    }
    await deps.syncGrants(restoredGrants).catch(() => {});
  }

  await deps.reopen(EVERYWHERE);
  record({ kind: "lifecycle", name: "backup:restore", detail: `${decoded.length} files` });
  return { ok: true, collections: collectionIds, plugins: [...new Set(pluginIds)], files: decoded.length };
}

/** What this needs from user-plugins.ts: the folder, the lists it keeps, and who hears a change. */
export interface Kept {
  store: Store;
  origin: string;
  list(app: string): Promise<UserPlugin[]>;
  /** Turns a plugin on or off in the folder it is kept in: an app's, or the one for every app. */
  setOn(folder: string, id: string, value: boolean): Promise<void>;
  /** A file as the plugin to run: its own source, or the plugin an agent file becomes. */
  plugin(file: string, text: string): Promise<{ source: string }>;
  tell(change: { app: string; added?: string[]; removed?: string }): void;
}

export function userPluginChanges({ store, origin, list, setOn, plugin, tell }: Kept) {
  const manifestOf = async (file: string, text: string) => readManifest((await plugin(file, text)).source);

  /** Looks up expected SHA-256 integrity for a registry package URL in /packages/index.json when present. */
  async function registryIntegrityOf(pathname: string): Promise<string | undefined> {
    try {
      const response = await fetch(new URL("/packages/index.json", origin));
      if (!response.ok) return undefined;
      const data = (await response.json()) as { packages?: { href?: string; integrity?: string }[] };
      const match = data.packages?.find((p) => p.href === pathname);
      return typeof match?.integrity === "string" && match.integrity ? match.integrity : undefined;
    } catch {
      return undefined;
    }
  }

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
   * Adds files to an app's folder: plugins (.js), agents (.agent.md) and the files they bring. Each plugin's manifest is
   * read first, and nothing is written if any is refused. A plugin that is added starts off.
   */
  async function add(app: string, files: File[], { quiet = false, href }: { quiet?: boolean; href?: string } = {}): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
    checkApp(app);
    if (!Array.isArray(files) || !files.length || files.length > 21) return { ok: false, error: "Add between 1 and 21 files" };
    const ids: string[] = [];
    /** A plugin is kept as <id>.js, whatever its file was called, so each id has one file. */
    const names = new Map<File, string>();
    const pluginMeta: { id: string; source: string; version?: string; listed: string[] }[] = [];
    for (const f of files) {
      if (!f || typeof f.name !== "string" || !FILE_PATH.test(f.name)) return { ok: false, error: `${f?.name}: a file name is letters, digits, ., - and _, in folders beside the plugin at most` };
      if (!(typeof f.data === "string" || f.data instanceof Blob)) return { ok: false, error: `${f.name}: no contents` };
      const size = typeof f.data === "string" ? f.data.length : f.data.size;
      if (size > MAX_BYTES) return { ok: false, error: `${f.name} is over 5 MB` };
      if (!isPlugin(f.name)) continue;
      try {
        const source = typeof f.data === "string" ? f.data : await f.data.text();
        const m = await manifestOf(f.name, source);
        if (ids.includes(m.id)) return { ok: false, error: `${f.name}: ${m.id} is in these files twice` };
        ids.push(m.id);
        names.set(f, keptAs(m.id, f.name));
        pluginMeta.push({ id: m.id, source, version: m.version, listed: isAgentFile(f.name) ? [] : (m.files ?? []) });
      } catch (error) {
        return { ok: false, error: `${f.name}: ${error instanceof Error ? error.message : error}` };
      }
    }
    if (!ids.length) return { ok: false, error: "Add at least one plugin (.js) or agent (.agent.md)" };
    for (const f of files) await store.writeFile(`user/${app}/${names.get(f) ?? f.name}`, f.data);
    // An id is a plugin or an agent, not both: the one added takes the place of the other.
    for (const name of names.values()) await store.removeFile(`user/${app}/${otherForm(name)}`).catch(() => {});
    const meta = await readPackageMeta(store);
    for (const pm of pluginMeta) {
      const companions = pm.listed.map((cname) => files.find((f) => f.name === cname)).filter((f): f is File => !!f);
      const integrity = await computeIntegrity(pm.source, companions);
      meta[`${app}/${pm.id}`] = {
        integrity,
        ...(pm.version ? { version: pm.version } : {}),
        ...(href ? { href } : meta[`${app}/${pm.id}`]?.href ? { href: meta[`${app}/${pm.id}`].href } : {}),
      };
    }
    await writePackageMeta(store, meta);
    for (const id of ids) await setOn(app, id, false);
    record({ kind: "lifecycle", name: "user-plugin:add", detail: `${app}: ${files.map((f) => f.name).join(", ")}` });
    if (!quiet) tell({ app, added: ids });
    return { ok: true, ids };
  }

  /**
   * A plugin's file and the files its manifest lists, read from this site, ready for add(): how the demos'
   * sample plugins are added, and how a person adds one from the registry (verifying SHA-256 integrity when present).
   */
  async function fetchFiles(
    url: string,
    expectedIntegrity?: string,
  ): Promise<{ ok: true; files: File[]; source: string; integrity: string; version?: string; href: string } | { ok: false; error: string }> {
    const href = new URL(url, origin);
    if (href.origin !== origin || !(href.pathname.endsWith(".js") || isAgentFile(href.pathname))) return { ok: false, error: "Add a plugin's .js file, or an agent's .agent.md file, from this site" };
    const get = async (u: URL) => {
      const response = await fetch(u);
      if (!response.ok) throw new Error(`${u.pathname} answered ${response.status}`);
      return response.blob();
    };
    try {
      const source = await (await get(href)).text();
      const name = href.pathname.split("/").pop()!;
      const manifest = await manifestOf(name, source);
      const companions: File[] = [];
      for (const fileName of manifest.files ?? []) companions.push({ name: fileName, data: await get(new URL(fileName, href)) });
      const integrity = await computeIntegrity(source, companions);
      const expected = expectedIntegrity ?? (await registryIntegrityOf(href.pathname));
      if (expected && integrity !== expected) {
        record({ kind: "denied", name: "registry:integrity", plugin: manifest.id, detail: `${href.pathname}: expected ${expected}, got ${integrity}` });
        return { ok: false, error: `Integrity check failed for ${manifest.name} (${href.pathname}): expected ${expected}, got ${integrity}` };
      }
      return {
        ok: true,
        files: [{ name, data: source }, ...companions],
        source,
        integrity,
        ...(manifest.version ? { version: manifest.version } : {}),
        href: href.pathname,
      };
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

  /**
   * Removes a plugin and the files its manifest lists, from the folder it is kept in. A space's own changes to an
   * app's plugins (`quiet`) reach only that app's folder: one the person uses in every app is theirs, and stays.
   */
  async function remove(app: string, id: string, { quiet = false } = {}): Promise<boolean> {
    const plugin = (await list(app)).find((p) => p.id === id && !(quiet && p.everywhere));
    if (!plugin) return false;
    const folder = folderOf(app, plugin);
    for (const name of await filesIn(folder, plugin)) await store.removeFile(`user/${folder}/${name}`);
    const meta = await readPackageMeta(store);
    if (meta[`${folder}/${id}`]) {
      delete meta[`${folder}/${id}`];
      await writePackageMeta(store, meta);
    }
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
      if (plugins.length !== 1 || typeof plugins[0].data !== "string") return "Add one plugin (.js) or agent (.agent.md) at a time, with the files its manifest lists";
      let manifest;
      try {
        manifest = await manifestOf(plugins[0].name, plugins[0].data);
      } catch (error) {
        return `${plugins[0].name}: ${error instanceof Error ? error.message : error}`;
      }
      const listed = new Set(manifest.files ?? []);
      const badName = files.find((f) => (f === plugins[0] ? !FILE_NAME.test(f.name) : !FILE_PATH.test(f.name)));
      if (badName) return `${badName.name}: a file name is letters, digits, ., - and _`;
      const extra = files.find((f) => f !== plugins[0] && !listed.has(f.name));
      if (extra) return `${extra.name} isn't one of the files ${manifest.id} lists`;
      const ours = new Set([keptAs(manifest.id, plugins[0].name), ...listed]);
      // Only the plugins kept in this same folder can lose a file to it.
      for (const other of await list(app)) {
        if (!other.id || other.id === manifest.id || folderOf(app, other) !== app) continue;
        const clash = (await filesIn(app, other)).find((name) => ours.has(name));
        if (clash) return `${clash} belongs to ${other.name ?? other.id}, another plugin ${app === EVERYWHERE ? "you use in every app" : "for this app"}`;
      }
      return undefined;
    },

    async addFromUrl(app: string, url: string, expectedIntegrity?: string) {
      const fetched = await fetchFiles(url, expectedIntegrity);
      return fetched.ok ? add(app, fetched.files, { href: fetched.href }) : fetched;
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
      // Every file is read before any is written or removed: one that can't be read leaves the plugin where it is.
      const files: [string, Blob][] = [];
      for (const name of names) {
        const bytes = await store.readBytes(`user/${from}/${name}`);
        if (bytes) {
          files.push([name, new Blob([bytes as BlobPart])]);
          continue;
        }
        // A file its manifest lists that was never added isn't there to move; the plugin itself, or a file that is there, must be read.
        const at = `user/${from}/${name}`.split("/");
        const file = at.pop()!;
        if (name === plugin.file || (await store.listFiles(at.join("/"))).includes(file)) return { ok: false, error: `${name} couldn't be read, so ${plugin.name ?? id} stays where it is` };
      }
      for (const [name, data] of files) await store.writeFile(`user/${to}/${name}`, data);
      // As when one is added: it takes the place of the other kind kept under its id where it is going.
      await store.removeFile(`user/${to}/${otherForm(plugin.file)}`).catch(() => {});
      for (const name of names) await store.removeFile(`user/${from}/${name}`);
      const meta = await readPackageMeta(store);
      if (meta[`${from}/${id}`]) {
        meta[`${to}/${id}`] = meta[`${from}/${id}`];
        delete meta[`${from}/${id}`];
        await writePackageMeta(store, meta);
      }
      await setOn(from, id, false);
      await setOn(to, id, plugin.on);
      record({ kind: "lifecycle", name: "user-plugin:everywhere", plugin: id, detail: `${from} to ${to}` });
      return { ok: true };
    },
  };
}
