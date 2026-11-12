// Content-addressed binary and media blobs for a space (src/shared/sync.ts):
// plugins store bytes with `sync.putBlob(data, mediaType)` -> `{ hash, size, mediaType }`
// and read them back with `sync.getBlob(hash)` -> `{ data, mediaType } | null`.
//
// Every blob is named by its SHA-256 hex digest and kept under `sync/blobs/<hash>`
// alongside `sync/blobs/index.json`, on both each member's device and the space's
// server. Because a hash names one exact byte sequence, any copy already on a
// device is final, and both ends check the digest before keeping what arrived.
//
// Large blobs are sliced into 512 KB pieces over the sync WebSocket so every
// JSON message stays comfortably inside the 1 MiB frame limit on Node and Cloudflare.

import type { BlobRequest, SyncToDevice } from "../../src/shared/sync";
import type { Host, Hosts } from "../../src/kernel/hosts";
import type { Store } from "../../src/kernel/store";
import { record as trace } from "../../src/kernel/trace";

const FOLDER = "sync/blobs";
const INDEX = "sync/blobs/index.json";
/** At most 2 MB per blob, and 32 MB across a space. */
export const MAX_BLOB = 2 * 1024 * 1024;
export const MAX_SPACE_BLOBS = 32 * 1024 * 1024;
/** Raw bytes per WebSocket message (~683 KB as base64, well under 1 MiB). */
const CHUNK_BYTES = 512 * 1024;
const WAIT_MS = 15_000;
const HASH = /^[0-9a-f]{64}$/;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9_.+-]+=[a-z0-9_.+-]+)*$/i;

interface BlobEntry {
  size: number;
  mediaType: string;
  by?: string;
  at: string;
  /** On a device: waiting to be sent to the space once connected. */
  pending?: boolean;
}

export interface BlobStored {
  hash: string;
  size: number;
  mediaType: string;
}

export interface BlobLoaded {
  data: Uint8Array;
  mediaType: string;
}

const toBase64 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function checkMediaType(value: unknown, fallback = "application/octet-stream"): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new Error("mediaType must be a string, such as image/png");
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.length > 128 || !MEDIA_TYPE.test(trimmed)) throw new Error("mediaType must be a valid MIME type, such as image/png");
  return trimmed;
}

/** Turns what a plugin passed (`Uint8Array`, `ArrayBuffer`, `Blob`, byte list or string/data URL) into bytes and a checked MIME type. */
export async function normalizeBlobInput(data: unknown, mediaType: unknown): Promise<{ bytes: Uint8Array; mediaType: string }> {
  let inferred: string | undefined;
  let bytes: Uint8Array;
  if (data instanceof Uint8Array) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (typeof Blob !== "undefined" && data instanceof Blob) {
    if (data.type) inferred = data.type;
    bytes = new Uint8Array(await data.arrayBuffer());
  } else if (Array.isArray(data) && data.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    bytes = Uint8Array.from(data);
  } else if (typeof data === "string") {
    const dataUrl = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(data);
    if (dataUrl) {
      if (dataUrl[1]) inferred = dataUrl[1];
      bytes = dataUrl[2] ? fromBase64(dataUrl[3]) : new TextEncoder().encode(decodeURIComponent(dataUrl[3]));
    } else {
      bytes = new TextEncoder().encode(data);
    }
  } else {
    throw new Error("putBlob takes binary bytes (Uint8Array, ArrayBuffer, Blob) or a string");
  }
  if (bytes.byteLength > MAX_BLOB) throw new Error(`A blob is at most ${MAX_BLOB / (1024 * 1024)} MB`);
  return { bytes, mediaType: checkMediaType(mediaType, inferred ?? "application/octet-stream") };
}

function concatBytes(parts: Uint8Array[], totalSize: number): Uint8Array {
  const out = new Uint8Array(totalSize);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Keeps blobs in a `Store` (`sync/blobs/<hash>` and `sync/blobs/index.json`), enforcing size caps. */
export function blobStore(store: Store) {
  let index: Record<string, BlobEntry> = Object.create(null);
  const loaded = store.readJson<unknown>(INDEX, {}).then((saved) => {
    if (saved && typeof saved === "object" && !Array.isArray(saved)) index = Object.assign(Object.create(null), saved);
  });
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };
  const totalBytes = () => Object.values(index).reduce((sum, entry) => sum + (typeof entry?.size === "number" ? entry.size : 0), 0);

  return {
    serially,
    async has(hash: string): Promise<BlobEntry | undefined> {
      await loaded;
      return HASH.test(hash) ? index[hash] : undefined;
    },
    async putBytes(hash: string, bytes: Uint8Array, mediaType: string, meta: { by?: string; pending?: boolean } = {}): Promise<{ stored: BlobStored; created: boolean }> {
      await loaded;
      if (!HASH.test(hash)) throw new Error("Not a SHA-256 blob hash");
      if (bytes.byteLength > MAX_BLOB) throw new Error(`A blob is at most ${MAX_BLOB / (1024 * 1024)} MB`);
      const actual = await sha256Hex(bytes);
      if (actual !== hash) throw new Error("Blob data doesn't match its SHA-256 hash");
      const checkedType = checkMediaType(mediaType);
      return serially(async () => {
        const existing = index[hash];
        const existingBytes = existing ? await store.readBytes(`${FOLDER}/${hash}`) : undefined;
        if (existing && existingBytes?.byteLength === bytes.byteLength) {
          if (existing.pending && meta.pending === false) {
            delete existing.pending;
            await store.writeJson(INDEX, index);
          }
          return { stored: { hash, size: existing.size, mediaType: existing.mediaType }, created: false };
        }
        if (!existing && totalBytes() + bytes.byteLength > MAX_SPACE_BLOBS) {
          throw new Error(`A space keeps at most ${MAX_SPACE_BLOBS / (1024 * 1024)} MB of blobs`);
        }
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        await store.writeFile(`${FOLDER}/${hash}`, new Blob([copy]));
        index[hash] = {
          size: bytes.byteLength,
          mediaType: existing?.mediaType ?? checkedType,
          ...(meta.by ? { by: meta.by } : {}),
          ...(meta.pending ? { pending: true } : {}),
          at: new Date().toISOString(),
        };
        await store.writeJson(INDEX, index);
        return { stored: { hash, size: bytes.byteLength, mediaType: index[hash].mediaType }, created: true };
      });
    },
    async markSynced(hash: string): Promise<void> {
      await loaded;
      return serially(async () => {
        if (index[hash]?.pending) {
          delete index[hash].pending;
          await store.writeJson(INDEX, index);
        }
      });
    },
    async pendingHashes(): Promise<string[]> {
      await loaded;
      return Object.entries(index)
        .filter(([, entry]) => entry?.pending)
        .map(([hash]) => hash);
    },
    async getBytes(hash: string): Promise<BlobLoaded | null> {
      await loaded;
      if (!HASH.test(hash)) return null;
      const meta = index[hash];
      const bytes = await store.readBytes(`${FOLDER}/${hash}`);
      if (!bytes) return null;
      return { data: bytes, mediaType: meta?.mediaType ?? "application/octet-stream" };
    },
  };
}

/** The space's side (on its server): stores verified content-addressed blobs and serves them to members' devices. */
export function spaceBlobs(store: Store, hosts: Hosts, tell: (message: SyncToDevice) => void) {
  const kept = blobStore(store);
  const maxChunks = Math.ceil(MAX_BLOB / CHUNK_BYTES);
  /** Multi-chunk uploads in progress, keyed by `<tab>:<hash>`. */
  const partial = new Map<string, { total: number; size: number; mediaType: string; parts: (Uint8Array | undefined)[] }>();

  async function answer(host: Host, m: BlobRequest): Promise<Omit<Extract<SyncToDevice, { op: "blobs:reply" }>, "t" | "op" | "id">> {
    if (!m || typeof m.hash !== "string" || !HASH.test(m.hash)) return { ok: false, error: "Not a SHA-256 blob hash" };
    if (m.action === "get") {
      const found = await kept.getBytes(m.hash);
      if (!found) return { ok: false, error: "The space has no such blob" };
      const total = Math.max(1, Math.ceil(found.data.byteLength / CHUNK_BYTES));
      const idx = m.index === undefined ? 0 : m.index;
      if (!Number.isInteger(idx) || idx < 0 || idx >= total) return { ok: false, error: "Blob chunk index out of range" };
      const slice = found.data.subarray(idx * CHUNK_BYTES, Math.min(found.data.byteLength, (idx + 1) * CHUNK_BYTES));
      return { ok: true, hash: m.hash, size: found.data.byteLength, mediaType: found.mediaType, data: toBase64(slice), index: idx, total };
    }
    if (m.action === "put") {
      if (!Number.isInteger(m.size) || m.size < 0 || m.size > MAX_BLOB) return { ok: false, error: `A blob is at most ${MAX_BLOB / (1024 * 1024)} MB` };
      if (typeof m.data !== "string") return { ok: false, error: "Blob data is base64" };
      const mediaType = checkMediaType(m.mediaType);
      const total = m.total ?? 1;
      const idx = m.index ?? 0;
      if (!Number.isInteger(total) || total < 1 || total > maxChunks || !Number.isInteger(idx) || idx < 0 || idx >= total) {
        return { ok: false, error: "Invalid blob chunk count" };
      }
      let chunk: Uint8Array;
      try {
        chunk = fromBase64(m.data);
      } catch {
        return { ok: false, error: "Blob data isn't valid base64" };
      }
      if (chunk.byteLength > CHUNK_BYTES) return { ok: false, error: "Blob chunk is too big" };

      let full: Uint8Array;
      if (total === 1) {
        if (chunk.byteLength !== m.size) return { ok: false, error: "Blob size doesn't match its bytes" };
        full = chunk;
      } else {
        const slotKey = `${host.tab}:${m.hash}`;
        let entry = partial.get(slotKey);
        if (!entry || entry.total !== total || entry.size !== m.size) {
          entry = { total, size: m.size, mediaType, parts: new Array<Uint8Array | undefined>(total).fill(undefined) };
          partial.set(slotKey, entry);
        }
        entry.parts[idx] = chunk;
        if (entry.parts.some((p) => p === undefined)) {
          return { ok: true, hash: m.hash, size: m.size, mediaType, index: idx, total };
        }
        partial.delete(slotKey);
        const assembled = concatBytes(entry.parts as Uint8Array[], entry.size);
        const sum = (entry.parts as Uint8Array[]).reduce((s, p) => s + p.byteLength, 0);
        if (sum !== m.size) return { ok: false, error: "Blob size doesn't match its bytes" };
        full = assembled;
      }

      const { stored, created } = await kept.putBytes(m.hash, full, mediaType, { by: host.member });
      if (created) {
        tell({ t: "sync", op: "blobs:changed", hash: stored.hash, size: stored.size, mediaType: stored.mediaType });
        trace({ kind: "note", name: "sync:blob", detail: `${stored.hash.slice(0, 12)} (${stored.size} B, ${stored.mediaType})${host.member ? `, from ${host.member}` : ""}` });
      }
      return { ok: true, ...stored };
    }
    return { ok: false, error: "Not something the space does with blobs" };
  }

  return {
    async handle(host: Host, m: BlobRequest): Promise<void> {
      const reply = await answer(host, m).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      hosts.send(host, { t: "sync", op: "blobs:reply", id: m.id, ...reply });
    },
    left(host: Host): void {
      const prefix = `${host.tab}:`;
      for (const k of [...partial.keys()]) if (k.startsWith(prefix)) partial.delete(k);
    },
    async put(data: unknown, mediaType: unknown): Promise<BlobStored> {
      const { bytes, mediaType: checked } = await normalizeBlobInput(data, mediaType);
      const hash = await sha256Hex(bytes);
      const { stored, created } = await kept.putBytes(hash, bytes, checked, { by: "server" });
      if (created) tell({ t: "sync", op: "blobs:changed", hash: stored.hash, size: stored.size, mediaType: stored.mediaType });
      return stored;
    },
    get: (hash: string) => kept.getBytes(hash),
  };
}

export type SpaceBlobs = ReturnType<typeof spaceBlobs>;

/** What the device side needs of `syncDevice` (device.ts). */
export interface BlobLink {
  status: { connected: boolean };
  state?(): Promise<{ access?: { role?: string; owner?: string } }>;
  send(message: BlobRequest): boolean;
  heard: Set<(message: SyncToDevice) => void>;
  caughtUp: Set<() => void>;
}

let nextRequestId = 0;

type BlobAsk =
  | { action: "put"; hash: string; mediaType: string; size: number; data: string; index?: number; total?: number }
  | { action: "get"; hash: string; index?: number };

function askBlob(link: BlobLink, request: BlobAsk): Promise<Extract<SyncToDevice, { op: "blobs:reply" }>> {
  const id = ++nextRequestId;
  return new Promise((resolve, reject) => {
    const done = () => {
      link.heard.delete(listen);
      clearTimeout(timer);
    };
    const listen = (m: SyncToDevice) => {
      if (m.op !== "blobs:reply" || m.id !== id) return;
      done();
      if (m.ok) resolve(m);
      else reject(new Error(m.error ?? "The space refused the blob"));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("The space didn't answer in time"));
    }, WAIT_MS);
    link.heard.add(listen);
    if (!link.send({ t: "sync", op: "blobs", id, ...request } as BlobRequest)) {
      done();
      reject(new Error("This page isn't connected to its space right now"));
    }
  });
}

async function uploadToSpace(link: BlobLink, hash: string, bytes: Uint8Array, mediaType: string): Promise<BlobStored> {
  const total = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
  let last!: Extract<SyncToDevice, { op: "blobs:reply" }>;
  for (let index = 0; index < total; index++) {
    const slice = bytes.subarray(index * CHUNK_BYTES, Math.min(bytes.byteLength, (index + 1) * CHUNK_BYTES));
    last = await askBlob(link, { action: "put", hash, mediaType, size: bytes.byteLength, data: toBase64(slice), ...(total > 1 ? { index, total } : {}) });
  }
  return { hash, size: last.size ?? bytes.byteLength, mediaType: last.mediaType ?? mediaType };
}

async function fetchFromSpace(link: BlobLink, hash: string): Promise<BlobLoaded | null> {
  let first: Extract<SyncToDevice, { op: "blobs:reply" }>;
  try {
    first = await askBlob(link, { action: "get", hash, index: 0 });
  } catch (error) {
    if (error instanceof Error && /no such blob/i.test(error.message)) return null;
    throw error;
  }
  if (typeof first.data !== "string" || typeof first.size !== "number") return null;
  const total = first.total ?? 1;
  const parts: Uint8Array[] = [fromBase64(first.data)];
  for (let index = 1; index < total; index++) {
    const next = await askBlob(link, { action: "get", hash, index });
    if (typeof next.data !== "string") throw new Error("Incomplete blob from space");
    parts.push(fromBase64(next.data));
  }
  const assembled = total === 1 ? parts[0] : concatBytes(parts, first.size);
  if ((await sha256Hex(assembled)) !== hash) throw new Error("Blob received from space failed SHA-256 verification");
  return { data: assembled, mediaType: first.mediaType ?? "application/octet-stream" };
}

/** Browser/local blob manager, syncing with `getLink()` when this kernel keeps a copy of a space. */
export function clientBlobs(store: Store, getLink: () => BlobLink | undefined, onRemoteBlob?: (blob: BlobStored) => void) {
  const kept = blobStore(store);
  const attached = new WeakSet<object>();

  const flushPending = async (link: BlobLink) => {
    for (const hash of await kept.pendingHashes()) {
      if (!link.status.connected) return;
      const meta = await kept.has(hash);
      const loaded = await kept.getBytes(hash);
      if (!loaded || !meta) continue;
      try {
        await uploadToSpace(link, hash, loaded.data, meta.mediaType);
        await kept.markSynced(hash);
      } catch (error) {
        trace({ kind: "error", name: "sync:blob-flush", detail: `${hash.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  };

  const ensureAttached = (link: BlobLink | undefined) => {
    if (!link || attached.has(link)) return;
    attached.add(link);
    link.heard.add((m) => {
      if (m.op === "blobs:changed") onRemoteBlob?.({ hash: m.hash, size: m.size, mediaType: m.mediaType });
    });
    link.caughtUp.add(() => void flushPending(link));
  };

  return {
    attach: ensureAttached,
    async put(data: unknown, mediaType: unknown): Promise<BlobStored> {
      const { bytes, mediaType: checked } = await normalizeBlobInput(data, mediaType);
      const hash = await sha256Hex(bytes);
      const link = getLink();
      ensureAttached(link);
      if (link?.status.connected) {
        // Upload first when connected so readers and space-quota refusals reject cleanly, and other devices can read `hash` right away.
        const uploaded = await uploadToSpace(link, hash, bytes, checked);
        await kept.putBytes(hash, bytes, uploaded.mediaType, { pending: false });
        return uploaded;
      }
      const access = link ? (await link.state?.())?.access : undefined;
      if (access?.role === "reader") {
        const ask = access.owner ? `the space's owner, ${access.owner},` : "the space's owner";
        throw new Error(`You can read this space but not change it. Ask ${ask} to make you an editor.`);
      }
      const { stored } = await kept.putBytes(hash, bytes, checked, { pending: !!link });
      return stored;
    },
    async get(hash: string): Promise<BlobLoaded | null> {
      if (typeof hash !== "string" || !HASH.test(hash)) return null;
      const local = await kept.getBytes(hash);
      if (local) return local;
      const link = getLink();
      ensureAttached(link);
      if (!link?.status.connected) return null;
      const fetched = await fetchFromSpace(link, hash);
      if (!fetched) return null;
      await kept.putBytes(hash, fetched.data, fetched.mediaType, { pending: false });
      return fetched;
    },
  };
}
