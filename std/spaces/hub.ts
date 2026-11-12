// A space's side of sync (src/shared/sync.ts says how it works): the space
// kernel orders every change its devices send, auto-merges stale edits when
// disjoint fields changed since `base`, refuses conflicting or unauthorized
// edits, keeps each accepted change in a log, and sends it to every device.
// Only a space kernel answers sync; a kernel in a browser refuses it.
//
// Kept in the space's folder, beside the collections:
//   sync/head.json          the latest sequence number, and each record's version
//   sync/log/<chunk>.json   the accepted changes, a hundred to a file, so a device catches up from any point

import type { Dispatch } from "../../src/shared/protocol";
import type { Accepted, AppRequest, BlobRequest, LiveToSpace, Outgoing, PluginRequest, ReflectRequest, ReviewToSpace, SyncRecord, SyncToDevice, SyncToSpace, TraceRequest, Verdict } from "../../src/shared/sync";
import { env } from "../../src/kernel/env";
import { hooks } from "../../src/kernel/hooks";
import type { Host, Hosts } from "../../src/kernel/hosts";
import type { Collections, StoredRecord } from "../../src/kernel/records";
import { validate } from "../../src/kernel/schema";
import type { Store } from "../../src/kernel/store";
import { record as trace } from "../../src/kernel/trace";
import type { SpacePermissions } from "./permissions";
import type { Role } from "./rules";

const HEAD = "sync/head.json";
const CHUNK = 100;
const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const ID = /^[\w-]{1,64}$/;
/** At most this many changes in one push, and this many bytes in one record. */
const MAX_PUSH = 100;
const MAX_RECORD = 100_000;

const chunkOf = (seq: number) => Math.floor((seq - 1) / CHUNK);
const chunkFile = (chunk: number) => `sync/log/${String(chunk).padStart(8, "0")}.json`;
const key = (collection: string, id: string) => `${collection}/${id}`;

/** Canonical value serialization so nested object key order doesn't count as a field change. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** Fields whose value (or presence) differs between `a` and `b`, ignoring record timestamps and `ignored`. */
function changedFields(a: SyncRecord, b: SyncRecord, ignored: ReadonlySet<string>): Set<string> {
  const diff = new Set<string>();
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (ignored.has(k) || k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const hasA = Object.hasOwn(a, k) && a[k] !== undefined;
    const hasB = Object.hasOwn(b, k) && b[k] !== undefined;
    if (hasA !== hasB) {
      diff.add(k);
    } else if (hasA && hasB && JSON.stringify(canonical(a[k])) !== JSON.stringify(canonical(b[k]))) {
      diff.add(k);
    }
  }
  return diff;
}

/**
 * `onApp` hears each app a device opens in the space (server-apps.ts). `after` is the work a stopped hub
 * of this space still had queued (its `stop()`): this one reads the log once that is written.
 */
export function syncHub(root: any, store: Store, records: Collections, hosts: Hosts, onApp?: (app: string) => unknown, after?: Promise<unknown>) {
  /** The devices that said hello, and so hear every change. */
  const listening = new Set<Host>();
  let head: { seq: number; versions: Record<string, number> } = { seq: 0, versions: {} };
  let headLoaded = false;
  const loaded = Promise.resolve(after).then(() => store.readJson<unknown>(HEAD, null)).then((saved) => {
    const s = saved as typeof head | null;
    if (s && typeof s.seq === "number" && s.versions && typeof s.versions === "object") head = { seq: s.seq, versions: { ...s.versions } };
    headLoaded = true;
    sent = head.seq;
  });

  /**
   * Changes go to devices in order of their numbers, with none missing: a device skips a number lower than
   * one it has. A server plugin's write can take a number while a push is under way, and finish after it, so
   * each change waits here for the ones before it. A number given to a change that then failed comes as null.
   */
  let sent = 0;
  const finished = new Map<number, Accepted | null>();
  function announce(seq: number, accepted: Accepted | null): void {
    finished.set(seq, accepted);
    const batch: Accepted[] = [];
    while (finished.has(sent + 1)) {
      const next = finished.get(sent + 1);
      finished.delete(++sent);
      if (next) batch.push(next);
    }
    if (batch.length) for (const other of listening) hosts.send(other, { t: "sync", op: "changes", changes: batch, seq: sent });
  }

  /** One push at a time, so each change is checked against the versions the one before it left. */
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };

  const readChunk = async (chunk: number): Promise<Accepted[]> => {
    const saved = await store.readJson<unknown>(chunkFile(chunk), []);
    return Array.isArray(saved) ? (saved as Accepted[]) : [];
  };

  /** Every accepted change after `since`, in order. */
  async function since(after: number): Promise<Accepted[]> {
    await loaded;
    const out: Accepted[] = [];
    for (let chunk = chunkOf(Math.max(after, 0) + 1); chunk <= chunkOf(head.seq) && head.seq > 0; chunk++) out.push(...(await readChunk(chunk)).filter((c) => c.seq > after));
    return out;
  }

  /**
   * Looks up the ancestor of `(collection, id)` at `base` from the sync log (or earlier in the same push),
   * and checks whether the record was deleted between `base` and `version`.
   */
  async function ancestorAt(collection: string, id: string, base: number, version: number, batchAccepted: Accepted[]): Promise<{ baseRecord: SyncRecord | null; deletedSince: boolean }> {
    let baseRecord: SyncRecord | null = null;
    let bestSeq = 0;
    let deletedSince = false;

    const inspect = (c: Accepted) => {
      if (c.collection !== collection || c.id !== id) return;
      if (c.seq <= base && c.seq >= bestSeq) {
        bestSeq = c.seq;
        baseRecord = c.after;
      } else if (c.seq > base && c.seq <= version && c.after === null) {
        deletedSince = true;
      }
    };

    // Fast path: `base` is normally the exact sequence number of the ancestor version.
    if (base > 0 && head.seq > 0) {
      const startChunk = chunkOf(base);
      const endChunk = chunkOf(Math.min(version, head.seq));
      for (let chunk = startChunk; chunk <= endChunk; chunk++) {
        for (const c of await readChunk(chunk)) inspect(c);
      }
      if (bestSeq === 0) {
        for (let chunk = startChunk - 1; chunk >= 0 && bestSeq === 0; chunk--) {
          for (const c of await readChunk(chunk)) inspect(c);
        }
      }
    }
    for (const c of batchAccepted) inspect(c);
    return { baseRecord, deletedSince };
  }

  /** Checks a change as a device sent it: names, sizes, and the collection's schema when this space knows it. */
  function problem(change: Outgoing): string | undefined {
    if (!change || typeof change !== "object") return "A change is an object";
    if (typeof change.collection !== "string" || !NAME.test(change.collection)) return "Not a collection's name";
    if (typeof change.id !== "string" || !ID.test(change.id)) return "Not a record's id";
    if (!Number.isInteger(change.base) || change.base < 0) return "base is the version the change was made from";
    if (change.after === null) return undefined;
    if (!change.after || typeof change.after !== "object" || Array.isArray(change.after) || change.after.id !== change.id) return "after is the record, with its id, or null";
    if (JSON.stringify(change.after).length > MAX_RECORD) return "That record is too big";
    const collection = records.registry.get(change.collection);
    if (collection) {
      const fields = Object.fromEntries(Object.entries(change.after).filter(([k]) => k !== "id" && k !== "createdAt" && k !== "updatedAt"));
      const errors = validate({ ...collection.schema, type: "object" }, fields);
      if (errors.length) return errors.map((e) => `${e.path} ${e.message}`).join("; ");
    }
    return undefined;
  }

  /**
   * Who made each change numbered but not in the log yet (an earlier change in the same push, or a server plugin's
   * write while a hook ran), by number. Taken out once the log has it.
   */
  const unlogged = new Map<number, string | undefined>();

  /** Who made the change numbered `seq`, as `{ by }`: nothing for a version no one is named for. Never waits for the log. */
  async function madeBy(seq: number): Promise<{ by?: string }> {
    if (!seq) return {};
    const by = unlogged.has(seq) ? unlogged.get(seq) : (await readChunk(chunkOf(seq)).catch(() => [] as Accepted[])).find((c) => c.seq === seq)?.by;
    return by ? { by } : {};
  }

  /** The record a change names, as the space has it, with its version: none if the change doesn't name one properly. */
  async function current(change: Outgoing): Promise<{ version?: number; record?: SyncRecord | null }> {
    if (!change || typeof change.collection !== "string" || !NAME.test(change.collection) || typeof change.id !== "string" || !ID.test(change.id)) return {};
    return { version: head.versions[key(change.collection, change.id)] ?? 0, record: ((await records.record(change.collection, change.id).catch(() => null)) as SyncRecord | null) ?? null };
  }

  /**
   * Checks and applies one change. When `change.base` trails `version` (> 0) and both the device and the
   * server edited disjoint fields without deleting the record, merges them into one combined record.
   */
  async function accept(change: Outgoing, by: string | undefined, dispatch: Dispatch, role?: Role, batchAccepted: Accepted[] = []): Promise<{ verdict: Verdict; accepted?: Accepted }> {
    const wrong = problem(change);
    if (wrong) return { verdict: { ok: false, error: wrong, ...(await current(change)) } };
    const version = head.versions[key(change.collection, change.id)] ?? 0;
    const before = (await records.record(change.collection, change.id)) as SyncRecord | null;
    // The member's role and the collection's rules decide first (permissions.ts): what they may not change, they are told who can,
    // even when the change is also out of date, so it isn't kept as a draft they could never send.
    const no = await api.permit?.may(change, before, by, role);
    if (no) return { verdict: { ok: false, error: no, denied: true, version, record: before } };
    const at = new Date().toISOString();
    let candidateAfter = change.after;
    let wasMerged = false;

    if (change.base !== version) {
      if (change.base > 0 && change.base < version && change.after !== null && before !== null) {
        const { baseRecord: loggedBase, deletedSince } = await ancestorAt(change.collection, change.id, change.base, version, batchAccepted);
        const fallbackBase = !loggedBase && change.before && typeof change.before === "object" && !Array.isArray(change.before) && change.before.id === change.id ? change.before : null;
        const baseRecord = loggedBase ?? fallbackBase;
        if (baseRecord && !deletedSince) {
          const ignored = new Set(["id", "createdAt", "updatedAt"]);
          const clientDiff = changedFields(baseRecord, change.after, ignored);
          const serverDiff = changedFields(baseRecord, before, ignored);
          const disjoint = clientDiff.size > 0 && ![...clientDiff].some((f) => serverDiff.has(f));
          if (disjoint) {
            const combined: SyncRecord = { ...before, id: change.id };
            for (const field of clientDiff) {
              if (Object.hasOwn(change.after, field) && change.after[field] !== undefined) combined[field] = change.after[field];
              else delete combined[field];
            }
            combined.createdAt = typeof before.createdAt === "string" ? before.createdAt : typeof change.after.createdAt === "string" ? change.after.createdAt : at;
            combined.updatedAt = at;
            const mergedProblem = problem({ ...change, base: version, after: combined });
            if (mergedProblem) return { verdict: { ok: false, error: mergedProblem, version, record: before } };
            candidateAfter = combined;
            wasMerged = true;
          }
        }
      }
      if (!wasMerged) {
        return { verdict: { ok: false, stale: true, version, record: before, ...(await madeBy(version)) } };
      }
    }

    // Every stored record has string timestamps (collections sort by updatedAt): a device's are kept, missing ones filled in.
    const after: SyncRecord | null =
      candidateAfter === null
        ? null
        : {
            ...candidateAfter,
            createdAt: typeof candidateAfter.createdAt === "string" ? candidateAfter.createdAt : typeof before?.createdAt === "string" ? before.createdAt : at,
            updatedAt: wasMerged ? at : typeof candidateAfter.updatedAt === "string" ? candidateAfter.updatedAt : at,
          };

    // The space's own plugins (step 7) can stop a change, as a browser's can stop a write.
    const name = `data:beforeWrite:${change.collection}`;
    if (hooks.has(name)) {
      const verdict = await root.serial(dispatch, name, { collection: change.collection, id: change.id, before: before ?? undefined, after: after ?? undefined, ...(by ? { by } : {}) });
      if (verdict && typeof verdict === "object" && "block" in verdict) return { verdict: { ok: false, error: String(verdict.block), version, record: before } };
    }
    // A server plugin may have written the record while its hook ran: then this change is stale too.
    const now = head.versions[key(change.collection, change.id)] ?? 0;
    if (now !== version) return { verdict: { ok: false, stale: true, version: now, record: (await current(change)).record ?? null, ...(await madeBy(now)) } };
    // The number is taken before the write, so a plugin's write that lands while this one is applied comes after it, in the log as in the data.
    const accepted: Accepted = { seq: head.seq + 1, collection: change.collection, id: change.id, after, ...(by ? { by } : {}), at };
    head.seq = accepted.seq;
    head.versions[key(change.collection, change.id)] = accepted.seq;
    unlogged.set(accepted.seq, by);
    try {
      await records.apply(change.collection, change.id, after as StoredRecord | null, dispatch, by);
    } catch (error) {
      announce(accepted.seq, null);
      throw error;
    }
    api.permit?.did(change.collection, change.id, !before, after === null, by);
    return { verdict: { ok: true, seq: accepted.seq, ...(wasMerged && after ? { merged: after } : {}) }, accepted };
  }

  /** Adds a push's accepted changes to the log, one write per chunk they fall in, then saves the head. */
  async function record(accepted: Accepted[]) {
    const byChunk = new Map<number, Accepted[]>();
    for (const a of accepted) byChunk.set(chunkOf(a.seq), [...(byChunk.get(chunkOf(a.seq)) ?? []), a]);
    // Merged by number: a server plugin's write may be logged after a later-numbered push.
    for (const [chunk, list] of byChunk) {
      const mine = new Set(list.map((a) => a.seq));
      await store.writeJson(chunkFile(chunk), [...(await readChunk(chunk)).filter((c) => !mine.has(c.seq)), ...list].sort((a, b) => a.seq - b.seq));
    }
    await store.writeJson(HEAD, head);
    for (const a of accepted) unlogged.delete(a.seq);
  }

  // On the server, a write the space's own plugins make (server-apps.ts) is a change like a device's:
  // it takes the next number, goes in the log, and reaches every device.
  // Its number is taken as it is written (this is heard right after the write), not when the log is next
  // free: a device's push waiting on a hook must see it, and come after it.
  type Written = Parameters<Collections["written"]["add"]>[0];
  const written: Written = (change, instance) => {
    const number = () => {
      const accepted: Accepted = { seq: head.seq + 1, collection: change.collection, id: change.id, after: (change.after as SyncRecord | undefined) ?? null, by: `plugin:${instance}`, at: new Date().toISOString() };
      head.seq = accepted.seq;
      head.versions[key(change.collection, change.id)] = accepted.seq;
      unlogged.set(accepted.seq, accepted.by);
      api.permit?.did(change.collection, change.id, !change.before, !change.after, accepted.by);
      return accepted;
    };
    const now = headLoaded ? number() : undefined;
    void serially(async () => {
      await loaded;
      const accepted = now ?? number();
      await record([accepted]);
      announce(accepted.seq, accepted);
    }).catch((error) => trace({ kind: "error", name: "sync:server-write", detail: String(error) }));
  };
  if (hosts.mode === "server") records.written.add(written);

  // Started again after a stopped hub (the spaces module restarted): the devices already connected said
  // hello to that one, so each is asked to say it again here, and catches up from the log it left.
  if (after) void loaded.then(() => {
    for (const host of hosts.list) hosts.send(host, { t: "sync", op: "again" });
  });

  /** The space's members' names by id, from the host's accounts; undefined where the host can't say. */
  async function names(): Promise<Record<string, string> | undefined> {
    try {
      const list = await env().members?.();
      if (!list) return undefined;
      return Object.fromEntries(list.filter((m) => typeof m?.id === "string" && typeof m.name === "string").map((m) => [m.id, m.name]));
    } catch (error) {
      trace({ kind: "error", name: "sync:members", detail: String(error) });
      return undefined;
    }
  }

  const api = {
    /** Who may change what (permissions.ts): the space's kernel sets this. Without it, every member may change everything. */
    permit: undefined as Pick<SpacePermissions, "may" | "told" | "reader" | "did"> | undefined,
    /** Members' plugins (plugins.ts): the space's kernel sets this. */
    plugins: undefined as ((host: Host, message: PluginRequest) => unknown) | undefined,
    /** Apps members made and shared (made-apps.ts): the space's kernel sets this. */
    apps: undefined as ((host: Host, message: AppRequest) => unknown) | undefined,
    /** Content-addressed binary/media blobs (blobs.ts): the space's kernel sets this. */
    blobs: undefined as ((host: Host, message: BlobRequest) => unknown) | undefined,
    /** Reviews the space's server asks its members for (reviews.ts): the space's kernel sets this. */
    reviews: undefined as ((host: Host, message: ReviewToSpace) => unknown) | undefined,
    /** A member's debugger asking what runs in the space's kernel (reflect.ts): the space's kernel sets this. */
    reflect: undefined as ((host: Host, message: ReflectRequest) => unknown) | undefined,
    /** Live messages from a device (live.ts), and its leaving: the space's kernel sets these. */
    live: undefined as ((host: Host, message: LiveToSpace) => unknown) | undefined,
    /** A member's debugger asking to hear the trace (trace.ts): the space's kernel sets this. */
    trace: undefined as ((host: Host, message: TraceRequest) => unknown) | undefined,
    /** Whatever else the space's kernel does when a device leaves. */
    left: new Set<(host: Host) => void>(),
    /** Sends a message to every device that said hello. */
    tell(message: SyncToDevice) {
      for (const other of listening) hosts.send(other, message);
    },
    /** A sync message from a device. */
    async handle(host: Host, message: SyncToSpace & { member?: string; role?: Role }): Promise<void> {
      if (hosts.mode !== "server") return hosts.send(host, { t: "sync", op: "refused", error: "Only a space's kernel answers sync" });
      await loaded;
      // The server says what this member may do with each message (src/server/signed.ts). A reader's that would change the space is answered here.
      const role = message.role;
      if (role === "reader" && (await api.permit?.reader(host, message))) return;
      if (message.op === "hello") {
        const after = Number.isInteger(message.since) && message.since >= 0 ? message.since : 0;
        // Each member's name, by id, so the device can show who made a change (`by`) by name.
        const members = await names();
        // Ordered with pushes, so a change accepted while this device catches up isn't missed or sent twice.
        await serially(async () => {
          // Read here, in order with pushes: an author kept by a push just before can't be undone by an older answer.
          const access = role && api.permit ? { role, ...(await api.permit.told()) } : {};
          // Only what has gone to every device: anything later comes to this one as it does to them.
          hosts.send(host, { t: "sync", op: "changes", changes: (await since(after)).filter((c) => c.seq <= sent), seq: sent, ...(host.member ? { member: host.member } : {}), ...(members ? { members } : {}), ...access });
          listening.add(host);
        });
        return;
      }
      if (message.op === "app") return void onApp?.(message.app);
      if (message.op === "review") return void api.reviews?.(host, message);
      if (message.op === "live") return void api.live?.(host, message);
      if (message.op === "trace") return void (api.trace ? api.trace(host, message) : hosts.send(host, { t: "sync", op: "trace", on: false, error: "This space doesn't stream its trace" }));
      if (message.op === "reflect") return void (api.reflect ? api.reflect(host, message) : hosts.send(host, { t: "sync", op: "reflect:reply", id: message.id, ok: false, error: "This space's kernel has no reflect module" }));
      if (message.op === "plugins") return void (api.plugins ? api.plugins(host, message) : hosts.send(host, { t: "sync", op: "plugins:reply", id: message.id, ok: false, error: "This space doesn't keep plugins" }));
      if (message.op === "apps") return void (api.apps ? api.apps(host, message) : hosts.send(host, { t: "sync", op: "apps:reply", id: message.id, ok: false, error: "This space doesn't keep apps" }));
      if (message.op === "blobs") return void (api.blobs ? api.blobs(host, message) : hosts.send(host, { t: "sync", op: "blobs:reply", id: message.id, ok: false, error: "This space doesn't keep blobs" }));
      if (message.op === "push") {
        const changes = Array.isArray(message.changes) ? message.changes.slice(0, MAX_PUSH) : [];
        const dispatch = { trace: `sync-${message.id}` };
        const results = await serially(async () => {
          const out: Verdict[] = [];
          const accepted: Accepted[] = [];
          for (const change of changes) {
            try {
              const { verdict, accepted: one } = await accept(change, host.member, dispatch, role, accepted);
              out.push(verdict);
              if (one) accepted.push(one);
            } catch (error) {
              out.push({ ok: false, error: String(error instanceof Error ? error.message : error), ...(await current(change)) });
            }
          }
          if (accepted.length) await record(accepted);
          for (const one of accepted) announce(one.seq, one);
          return out;
        });
        trace({ kind: "note", name: "sync:push", detail: `${results.filter((r) => r.ok).length} of ${changes.length} accepted${host.member ? `, from ${host.member}` : ""}` });
        return hosts.send(host, { t: "sync", op: "pushed", id: message.id, results });
      }
    },
    hostLeft: (host: Host) => {
      listening.delete(host);
      for (const then of api.left) then(host);
    },
    /** The latest sequence number and the accepted changes after `n`, for checks and tools. */
    since,
    /**
     * Stops hearing the space's own writes and sending changes. Returns the work still queued, which the
     * next hub waits for: it reads the log once that is written, so no number is taken twice.
     */
    stop(): Promise<unknown> {
      records.written.delete(written);
      listening.clear();
      return queue;
    },
  };
  return api;
}
