// Made apps in a space: a member who made an app (std/maker, at
// /s/<space>/new/) can share it with the space. The space keeps a copy of its
// files, and each other member sees it in their Your apps as from the space.
// It runs for them only once they accept its files on a review card, which
// saves it as a made app on their device like any other; a later change the
// sharer makes arrives the same way, as a new version to accept. The space
// never runs a made app: it keeps the files and hands them out.
//
// Stopping sharing takes it off the space's list. Members who accepted it
// keep their copy, as an app of their own.
//
// The space's side keeps each app under `made/shared/<name>/`, and a list of
// them, with who shared each, in `made/shared.json`: `made` belongs to the
// platform (paths.ts), so no plugin can write there.
//
// They speak over the sync socket (src/shared/sync.ts), as members' plugins
// do (plugins.ts): a device asks for the list, and the space tells every
// device when it changes.

import type { AppRequest, SharedAppSummary, SyncToDevice } from "../../src/shared/sync";
import type { Host, Hosts } from "../../src/kernel/hosts";
import { readManifest } from "../../src/kernel/manifest";
import type { MadeAppsSeam } from "../../src/kernel/modules";
import type { Store } from "../../src/kernel/store";
import { record as trace } from "../../src/kernel/trace";
import { APP_NAME, FILE_NAME, pageParts, pageProblems } from "../../sw/made-page.js";

const INDEX = "made/shared.json";
const FOLDER = "made/shared";
/** An app and its files, as sent: one WebSocket message, which Cloudflare caps at 1 MiB. */
const MAX_BYTES = 700_000;
const MAX_FILES = 30;
const MAX_APPS = 100;

type File = { name: string; text: string };
type Kept = { title: string; hash: string; files: string[]; by?: string; at: string };

const sizeOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

async function hashOf(files: File[]): Promise<string> {
  const text = JSON.stringify([...files].sort((a, b) => a.name.localeCompare(b.name)).map((f) => [f.name, f.text]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Why these can't be a shared app, if they can't: the rules a made app's files follow (sw/made-page.js). */
function problem(name: unknown, files: unknown): string | undefined {
  if (typeof name !== "string" || !APP_NAME.test(name)) return "That isn't an app's name";
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) return `A shared app is between 1 and ${MAX_FILES} files`;
  const names = new Set<string>();
  for (const f of files) {
    if (!f || typeof f !== "object" || typeof f.name !== "string" || typeof f.text !== "string") return "Each file is { name, text }";
    if (!FILE_NAME.test(f.name)) return `${f.name} isn't a file a made app can have`;
    if (names.has(f.name)) return `${f.name} is there twice`;
    names.add(f.name);
    if (f.name.endsWith(".js")) {
      try {
        readManifest(f.text);
      } catch (error) {
        return `${f.name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  const page = (files as File[]).find((f) => f.name === "app.html");
  if (!page) return "A shared app has its app.html";
  const wrong = pageProblems(page.text)[0];
  if (wrong) return `app.html, line ${wrong.line}: ${wrong.message}`;
  if (sizeOf(files) > MAX_BYTES) return "A shared app and its files are 700 KB at most";
  return undefined;
}

/** The space's side: keeps the apps members share, and tells every device when the list changes. */
export function spaceMadeApps(store: Store, hosts: Hosts, tell: (message: SyncToDevice) => void) {
  let index: Record<string, Kept> = Object.create(null);
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
  const list = (): SharedAppSummary[] => Object.entries(index).map(([name, kept]) => ({ name, ...kept }));

  async function answer(host: Host, m: AppRequest): Promise<Omit<Extract<SyncToDevice, { op: "apps:reply" }>, "t" | "op" | "id">> {
    await loaded;
    if (m.action === "list") return { ok: true, list: list() };
    if (typeof m.name !== "string" || !APP_NAME.test(m.name)) return { ok: false, error: "That isn't an app's name" };
    const name = m.name;
    if (m.action === "get") {
      const kept = index[name];
      if (!kept) return { ok: false, error: "The space has no such app" };
      const files: File[] = [];
      for (const f of kept.files) {
        const text = await store.readText(`${FOLDER}/${name}/${f}`);
        if (text !== undefined) files.push({ name: f, text });
      }
      return { ok: true, files, hash: kept.hash };
    }
    if (m.action === "unshare") {
      return serially(async () => {
        const kept = index[name];
        if (!kept) return { ok: true };
        for (const f of kept.files) await store.removeFile(`${FOLDER}/${name}/${f}`);
        delete index[name];
        await store.writeJson(INDEX, index);
        tell({ t: "sync", op: "apps:changed" });
        trace({ kind: "lifecycle", name: "shared-app:unshare", detail: `${name}${host.member ? `, by ${host.member}` : ""}` });
        return { ok: true };
      });
    }
    if (m.action === "share") {
      const wrong = problem(name, m.files);
      if (wrong) return { ok: false, error: wrong };
      return serially(async () => {
        if (!index[name] && Object.keys(index).length >= MAX_APPS) return { ok: false, error: `A space keeps ${MAX_APPS} apps at most` };
        const files = m.files.map((f) => ({ name: f.name, text: f.text }));
        const hash = await hashOf(files);
        if (index[name]?.hash === hash) return { ok: true, hash };
        // A file the new version doesn't have goes, so a member who accepts it gets just these.
        for (const f of index[name]?.files ?? []) if (!files.some((x) => x.name === f)) await store.removeFile(`${FOLDER}/${name}/${f}`);
        for (const f of files) await store.writeText(`${FOLDER}/${name}/${f.name}`, f.text);
        const title = pageParts(files.find((f) => f.name === "app.html")!.text).title || name;
        index[name] = { title, hash, files: files.map((f) => f.name).sort(), ...(host.member ? { by: host.member } : {}), at: new Date().toISOString() };
        await store.writeJson(INDEX, index);
        tell({ t: "sync", op: "apps:changed" });
        trace({ kind: "lifecycle", name: "shared-app:share", detail: `${name}${host.member ? `, by ${host.member}` : ""}` });
        return { ok: true, hash };
      });
    }
    return { ok: false, error: "Not something the space does with apps" };
  }

  return {
    /** A device's request: answered on its socket, with the request's id. */
    async handle(host: Host, m: AppRequest): Promise<void> {
      const reply = await answer(host, m).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      hosts.send(host, { t: "sync", op: "apps:reply", id: m.id, ...reply });
    },
  };
}

/** What a device's sync (device.ts) gives this: its socket, and what it hears on it. */
interface DeviceSocket {
  send(message: AppRequest): boolean;
  heard: Set<(message: SyncToDevice) => void>;
  caughtUp: Set<() => void>;
}

/**
 * A device's side, lent to the maker module through the space seam (MadeAppsSeam): asks the space for its
 * shared apps, shares one, and hears when the list changes. `names` gives members' names by id.
 */
export function deviceMadeApps(socket: DeviceSocket, names: () => Promise<Record<string, string>>): MadeAppsSeam & { stop(): void } {
  const waiting = new Map<number, (reply: Extract<SyncToDevice, { op: "apps:reply" }> | undefined) => void>();
  let asked = 0;
  type Ask = AppRequest extends infer R ? (R extends AppRequest ? Omit<R, "t" | "op" | "id"> : never) : never;
  function ask(request: Ask): Promise<Extract<SyncToDevice, { op: "apps:reply" }> | undefined> {
    const id = ++asked;
    return new Promise((done) => {
      if (!socket.send({ t: "sync", op: "apps", id, ...request } as AppRequest)) return done(undefined);
      waiting.set(id, done);
      setTimeout(() => {
        if (waiting.delete(id)) done(undefined);
      }, 20_000);
    });
  }
  const changed = new Set<() => void>();
  const tellChanged = () => {
    for (const then of changed) then();
  };
  const heard = (message: SyncToDevice) => {
    if (message.op === "apps:reply") {
      const done = waiting.get(message.id);
      waiting.delete(message.id);
      done?.(message);
    } else if (message.op === "apps:changed") tellChanged();
  };
  socket.heard.add(heard);
  socket.caughtUp.add(tellChanged);
  const offline = "The space can't be reached just now: try again once this device is back online";

  return {
    changed,
    async list() {
      const reply = await ask({ action: "list" });
      if (!reply) return undefined;
      if (!reply.ok || !reply.list) return [];
      const who = await names().catch(() => ({}) as Record<string, string>);
      return reply.list.map((a) => ({ ...a, ...(a.by ? { byName: who[a.by] ?? a.by } : {}) }));
    },
    async get(name) {
      const reply = await ask({ action: "get", name });
      if (!reply) return { ok: false, error: offline };
      return reply.ok && reply.files && reply.hash ? { ok: true, files: reply.files, hash: reply.hash } : { ok: false, error: reply.error ?? "The space has no such app" };
    },
    async share(name, files) {
      const reply = await ask({ action: "share", name, files });
      if (!reply) return { ok: false, error: offline };
      return reply.ok && reply.hash ? { ok: true, hash: reply.hash } : { ok: false, error: reply.error ?? "The space didn't take it" };
    },
    async unshare(name) {
      const reply = await ask({ action: "unshare", name });
      if (!reply) return { ok: false, error: offline };
      return reply.ok ? { ok: true } : { ok: false, error: reply.error ?? "The space didn't take it" };
    },
    stop() {
      socket.heard.delete(heard);
      socket.caughtUp.delete(tellChanged);
      changed.clear();
    },
  };
}
