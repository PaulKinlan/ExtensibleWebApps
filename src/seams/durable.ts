// The files and records seams on a Durable Object's SQLite database
// (Cloudflare). Each space's kernel runs as a Durable Object of its own
// (src/server/cloudflare/), so this is that space's folder and change log.
// SQLite in a Durable Object is synchronous, so each method runs without
// another caller stepping in between its statements.

import { checkPath, type Change, type Files, type Records, type Stored } from "./index.ts";

/** The part of a Durable Object's `ctx.storage.sql` this uses. */
export interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** SQLite in a Durable Object stores an ArrayBuffer as a BLOB. */
const blob = (data: Uint8Array | string): ArrayBuffer => {
  const b = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

export function durableFiles(sql: Sql): Files {
  sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, data BLOB NOT NULL)");
  const one = (path: string): Uint8Array | null => {
    const [row] = sql.exec("SELECT data FROM files WHERE path = ?", checkPath(path)).toArray();
    return row ? new Uint8Array(row.data as ArrayBuffer) : null;
  };
  return {
    async read(path) {
      return one(path);
    },
    async readText(path) {
      const data = one(path);
      return data ? new TextDecoder().decode(data) : null;
    },
    async write(path, data) {
      sql.exec("INSERT INTO files (path, data) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET data = excluded.data", checkPath(path), blob(data));
    },
    async remove(path) {
      sql.exec("DELETE FROM files WHERE path = ?", checkPath(path));
    },
    async list(prefix) {
      // A range on the key, so SQLite reads only the paths under the prefix (and a prefix with LIKE's
      // wildcards in it still means only itself). U+10FFFF sorts after every other character.
      return sql
        .exec("SELECT path FROM files WHERE path >= ? AND path < ? ORDER BY path", prefix, `${prefix}\u{10FFFF}`)
        .toArray()
        .map((r) => String(r.path))
        .filter((p) => p.startsWith(prefix));
    },
  };
}

/** Records and their change log on a Durable Object's SQLite database. */
export function durableRecords(sql: Sql): Records {
  sql.exec("CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection, id))");
  sql.exec("CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, id TEXT NOT NULL, before TEXT, after TEXT)");
  const row = (r?: Record<string, unknown>): Stored | null => (r ? { id: String(r.id), version: Number(r.version), value: JSON.parse(String(r.value)) } : null);
  return {
    async get(collection, id) {
      const [r] = sql.exec("SELECT id, version, value FROM records WHERE collection = ? AND id = ?", collection, id).toArray();
      return row(r);
    },
    async list(collection) {
      return sql
        .exec("SELECT id, version, value FROM records WHERE collection = ? ORDER BY id", collection)
        .toArray()
        .map((r) => row(r)!);
    },
    async put(collection, id, value, base) {
      const [existing] = sql.exec("SELECT id, version, value FROM records WHERE collection = ? AND id = ?", collection, id).toArray();
      const current = row(existing);
      if (base !== undefined && base !== (current?.version ?? 0)) return { ok: false as const, stale: true as const, current };
      const after = JSON.stringify(value);
      sql.exec("INSERT INTO changes (collection, id, before, after) VALUES (?, ?, ?, ?)", collection, id, current ? JSON.stringify(current.value) : null, after);
      const [inserted] = sql.exec("SELECT last_insert_rowid() AS seq").toArray();
      const seq = Number(inserted.seq);
      sql.exec("INSERT INTO records (collection, id, version, value) VALUES (?, ?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET version = excluded.version, value = excluded.value", collection, id, seq, after);
      return { ok: true as const, seq };
    },
    async remove(collection, id, base) {
      const [existing] = sql.exec("SELECT id, version, value FROM records WHERE collection = ? AND id = ?", collection, id).toArray();
      const current = row(existing);
      if (!current) return { ok: false as const, stale: false as const, missing: true as const };
      if (base !== undefined && base !== current.version) return { ok: false as const, stale: true as const, current };
      sql.exec("INSERT INTO changes (collection, id, before, after) VALUES (?, ?, ?, ?)", collection, id, JSON.stringify(current.value), null);
      const [inserted] = sql.exec("SELECT last_insert_rowid() AS seq").toArray();
      const seq = Number(inserted.seq);
      sql.exec("DELETE FROM records WHERE collection = ? AND id = ?", collection, id);
      return { ok: true as const, seq };
    },
    async changes(since, limit = 500) {
      return sql
        .exec("SELECT seq, collection, id, before, after FROM changes WHERE seq > ? ORDER BY seq LIMIT ?", since, limit)
        .toArray()
        .map((r): Change => ({
          seq: Number(r.seq),
          collection: String(r.collection),
          id: String(r.id),
          ...(r.before !== null && r.before !== undefined ? { before: JSON.parse(String(r.before)) } : {}),
          ...(r.after !== null && r.after !== undefined ? { after: JSON.parse(String(r.after)) } : {}),
        }));
    },
  };
}
