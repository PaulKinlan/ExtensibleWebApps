// Seams on a Node machine: a folder on disk, a SQLite file, timers that are
// written down so they survive a restart, an env file of secrets, and an
// outbox folder standing in for email until an SMTP provider is added.
// Everything for one space lives under one folder:
//
//   <space>/files/…        the kernel's folder (plugins, settings, reviews)
//   <space>/records.sqlite collections and the change log
//   <space>/schedule.json  jobs
//   <space>/outbox/        email, one JSON file per message
//
// Secrets come from an env file the deployment keeps outside the space.

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkPath, type Change, type Email, type Files, type Job, type Records, type Schedule, type Seams, type Secrets, type Stored } from "./index.ts";
import { memorySchedule } from "./memory.ts";

/** The end of a file's name while it is being written (nodeFiles' write). */
const PARTIAL = ".partial";

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export function nodeFiles(root: string): Files {
  /**
   * The file on disk for a path. The spelling is checked by checkPath; then no part of it under the root
   * may be a symlink, which could lead out of the folder whatever the path says.
   */
  const full = async (path: string) => {
    const parts = checkPath(path).split("/");
    for (let i = 1; i <= parts.length; i++) {
      const at = join(root, ...parts.slice(0, i));
      try {
        if ((await lstat(at)).isSymbolicLink()) throw new Error(`Not a path in the folder: ${JSON.stringify(path)} goes through a link`);
      } catch (error) {
        if (missing(error)) break;
        throw error;
      }
    }
    return join(root, ...parts);
  };
  return {
    async read(path) {
      try {
        return new Uint8Array(await readFile(await full(path)));
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async readText(path) {
      try {
        return await readFile(await full(path), "utf8");
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async write(path, data) {
      const file = await full(path);
      await mkdir(dirname(file), { recursive: true });
      // Written beside it, then moved into place: a read at the same moment gets the old file or the new one,
      // never a half-written one (an account's session, read while it is saved again).
      const part = `${file}.${randomUUID()}${PARTIAL}`;
      try {
        await writeFile(part, data);
        await rename(part, await full(path));
      } catch (error) {
        await rm(part, { force: true });
        throw error;
      }
    },
    async remove(path) {
      await rm(await full(path), { force: true });
    },
    async list(prefix) {
      const all: string[] = [];
      const walk = async (dir: string) => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (error) {
          if (missing(error)) return;
          throw error;
        }
        for (const e of entries) {
          const path = join(dir, e.name);
          // Links aren't followed: what they point at isn't in the folder.
          if (e.isDirectory()) await walk(path);
          else if (e.isFile() && !e.name.endsWith(PARTIAL)) all.push(relative(root, path).split(sep).join("/"));
        }
      };
      await walk(root);
      return all.filter((p) => p.startsWith(prefix)).sort();
    },
  };
}

/** Records in one SQLite file. Each change is a row in `changes`, whose number is the record's new version. */
export function nodeRecords(file: string): Records {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection, id));
    CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, id TEXT NOT NULL, before TEXT, after TEXT);
  `);
  const getOne = db.prepare("SELECT id, version, value FROM records WHERE collection = ? AND id = ?");
  const getAll = db.prepare("SELECT id, version, value FROM records WHERE collection = ? ORDER BY id");
  const log = db.prepare("INSERT INTO changes (collection, id, before, after) VALUES (?, ?, ?, ?)");
  const upsert = db.prepare("INSERT INTO records (collection, id, version, value) VALUES (?, ?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET version = excluded.version, value = excluded.value");
  const del = db.prepare("DELETE FROM records WHERE collection = ? AND id = ?");
  const since = db.prepare("SELECT seq, collection, id, before, after FROM changes WHERE seq > ? ORDER BY seq LIMIT ?");
  const row = (r: any): Stored | null => (r ? { id: String(r.id), version: Number(r.version), value: JSON.parse(String(r.value)) } : null);
  /** Runs `fn` as one transaction: SQLite here is synchronous, so nothing else runs in between. */
  const atomically = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return {
    async get(collection, id) {
      return row(getOne.get(collection, id));
    },
    async list(collection) {
      return getAll.all(collection).map((r) => row(r)!);
    },
    async put(collection, id, value, base) {
      return atomically(() => {
        const current = row(getOne.get(collection, id));
        if (base !== undefined && base !== (current?.version ?? 0)) return { ok: false as const, stale: true as const, current };
        const after = JSON.stringify(value);
        const seq = Number(log.run(collection, id, current ? JSON.stringify(current.value) : null, after).lastInsertRowid);
        upsert.run(collection, id, seq, after);
        return { ok: true as const, seq };
      });
    },
    async remove(collection, id, base) {
      return atomically(() => {
        const current = row(getOne.get(collection, id));
        if (!current) return { ok: false as const, stale: false as const, missing: true as const };
        if (base !== undefined && base !== current.version) return { ok: false as const, stale: true as const, current };
        const seq = Number(log.run(collection, id, JSON.stringify(current.value), null).lastInsertRowid);
        del.run(collection, id);
        return { ok: true as const, seq };
      });
    },
    async changes(from, limit = 500) {
      return since.all(from, limit).map((r: any): Change => ({
        seq: Number(r.seq),
        collection: String(r.collection),
        id: String(r.id),
        ...(r.before !== null && { before: JSON.parse(String(r.before)) }),
        ...(r.after !== null && { after: JSON.parse(String(r.after)) }),
      }));
    },
  };
}

/** Timers, with the jobs written to a JSON file after every change, and read back when the host starts. */
export async function nodeSchedule(file: string, onError?: (name: string, error: unknown) => void): Promise<Schedule> {
  const jobs = new Map<string, Job>();
  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    // No file is no jobs yet; a file that can't be read stops the host, rather than starting empty and writing over it.
    if (!missing(error)) throw error;
  }
  if (text !== undefined) for (const job of JSON.parse(text) as Job[]) jobs.set(job.name, job);
  const inner = memorySchedule(jobs, onError);
  // One save at a time, each written beside the file and renamed over it, so the file is always whole.
  let saving: Promise<void> = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify([...jobs.values()], null, 2);
    saving = saving.catch(() => {}).then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot);
      await rename(temp, file);
    });
    return saving;
  };
  return {
    async set(job) {
      await inner.set(job);
      await save();
    },
    async cancel(name) {
      await inner.cancel(name);
      await save();
    },
    list: () => inner.list(),
    onDue(handler) {
      // A job that ran moved on (or went): write that down before telling the kernel.
      inner.onDue(async (name) => {
        await save();
        await handler(name);
      });
    },
    stop: () => inner.stop(),
  };
}

/** Secrets from an env file: NAME=value lines, # for comments, values optionally in quotes. */
export async function nodeSecrets(envFile: string): Promise<Secrets> {
  const values: Record<string, string> = {};
  let text = "";
  try {
    text = await readFile(envFile, "utf8");
  } catch {
    // No secrets.
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    values[m[1]] = m[2].replace(/^"(.*)"$|^'(.*)'$/, "$1$2");
  }
  return {
    async get(name) {
      return Object.hasOwn(values, name) ? values[name] : undefined;
    },
    async names() {
      return Object.keys(values).sort();
    },
  };
}

/** Email written to an outbox folder, one JSON file per message, for development. */
export function nodeOutbox(dir: string): Email {
  return {
    async send(message) {
      if (!message.to?.length || message.to.some((to) => !/^[^@\s]+@[^@\s]+$/.test(to))) return { ok: false, error: "Every recipient needs an email address" };
      // Time first, so the folder lists in the order mail was sent; random after, so two outboxes never share a name.
      const id = `${Date.now()}-${randomUUID()}`;
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.json`), JSON.stringify(message, null, 2));
      return { ok: true, id };
    },
  };
}

/** Every seam for one space, under its folder. */
export async function nodeSeams(space: string, envFile: string): Promise<Seams> {
  await mkdir(space, { recursive: true });
  return {
    files: nodeFiles(join(space, "files")),
    records: nodeRecords(join(space, "records.sqlite")),
    schedule: await nodeSchedule(join(space, "schedule.json")),
    secrets: await nodeSecrets(envFile),
    email: nodeOutbox(join(space, "outbox")),
  };
}
