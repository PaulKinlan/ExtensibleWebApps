// The files seam on a Durable Object's SQLite database (Cloudflare). Each
// space's kernel runs as a Durable Object of its own (src/server/cloudflare/),
// so this is that space's folder: one row per file. SQLite in a Durable
// Object is synchronous and every call here is one statement, so a write is
// whole or not there at all.

import { checkPath, type Files } from "./index.ts";

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
