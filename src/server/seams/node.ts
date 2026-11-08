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

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkPath, type Change, type Email, type Files, type Job, type Records, type Schedule, type Seams, type Secrets, type Stored } from "./index.ts";
import { memorySchedule } from "./memory.ts";

export function nodeFiles(root: string): Files {
  const full = (path: string) => join(root, ...checkPath(path).split("/"));
  const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
  return {
    async read(path) {
      try {
        return new Uint8Array(await readFile(full(path)));
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async readText(path) {
      try {
        return await readFile(full(path), "utf8");
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async write(path, data) {
      const file = full(path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, data);
    },
    async remove(path) {
      await rm(full(path), { force: true });
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
          if (e.isDirectory()) await walk(path);
          else if (e.isFile()) all.push(relative(root, path).split(sep).join("/"));
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
export async function nodeSchedule(file: string): Promise<Schedule> {
  const jobs = new Map<string, Job>();
  try {
    for (const job of JSON.parse(await readFile(file, "utf8")) as Job[]) jobs.set(job.name, job);
  } catch {
    // No jobs yet.
  }
  const inner = memorySchedule(jobs);
  const save = async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify([...jobs.values()], null, 2));
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
  let n = 0;
  return {
    async send(message) {
      if (!message.to?.length || message.to.some((to) => !/^[^@\s]+@[^@\s]+$/.test(to))) return { ok: false, error: "Every recipient needs an email address" };
      const id = `${Date.now()}-${++n}`;
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
