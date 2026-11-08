// A space's side of sync (src/shared/sync.ts says how it works): the space
// kernel orders every change its devices send, refuses stale ones, keeps
// each accepted change in a log, and sends it to every device. Only a space
// kernel answers sync; a kernel in a browser refuses it.
//
// Kept in the space's folder, beside the collections:
//   sync/head.json          the latest sequence number, and each record's version
//   sync/log/<chunk>.json   the accepted changes, a hundred to a file, so a device catches up from any point

import type { Dispatch } from "../shared/protocol";
import type { Accepted, Outgoing, SyncRecord, SyncToSpace, Verdict } from "../shared/sync";
import { hooks } from "./hooks";
import type { Host, Hosts } from "./hosts";
import type { Collections, StoredRecord } from "./records";
import { validate } from "./schema";
import type { Store } from "./store";
import { record as trace } from "./trace";

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

/** `onApp` hears each app a device opens in the space (server-apps.ts). */
export function syncHub(root: any, store: Store, records: Collections, hosts: Hosts, onApp?: (app: string) => unknown) {
  /** The devices that said hello, and so hear every change. */
  const listening = new Set<Host>();
  let head: { seq: number; versions: Record<string, number> } = { seq: 0, versions: {} };
  let headLoaded = false;
  const loaded = store.readJson<unknown>(HEAD, null).then((saved) => {
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
      const fields = Object.fromEntries(Object.entries(change.after).filter(([k]) => !["id", "createdAt", "updatedAt"].includes(k)));
      const errors = validate({ ...collection.schema, type: "object" }, fields);
      if (errors.length) return errors.map((e) => `${e.path} ${e.message}`).join("; ");
    }
    return undefined;
  }

  /** The record a change names, as the space has it, with its version: none if the change doesn't name one properly. */
  async function current(change: Outgoing): Promise<{ version?: number; record?: SyncRecord | null }> {
    if (!change || typeof change.collection !== "string" || !NAME.test(change.collection) || typeof change.id !== "string" || !ID.test(change.id)) return {};
    return { version: head.versions[key(change.collection, change.id)] ?? 0, record: ((await records.record(change.collection, change.id).catch(() => null)) as SyncRecord | null) ?? null };
  }

  /**
   * Checks and applies one change. The space's head moves on in memory; the push writes the log and
   * head once, when all its changes are in (`record`).
   */
  async function accept(change: Outgoing, by: string | undefined, dispatch: Dispatch): Promise<{ verdict: Verdict; accepted?: Accepted }> {
    const wrong = problem(change);
    if (wrong) return { verdict: { ok: false, error: wrong, ...(await current(change)) } };
    const version = head.versions[key(change.collection, change.id)] ?? 0;
    const before = (await records.record(change.collection, change.id)) as SyncRecord | null;
    if (change.base !== version) return { verdict: { ok: false, stale: true, version, record: before } };
    const at = new Date().toISOString();
    // Every stored record has string timestamps (collections sort by updatedAt): a device's are kept, missing ones filled in.
    const after: SyncRecord | null =
      change.after === null
        ? null
        : {
            ...change.after,
            createdAt: typeof change.after.createdAt === "string" ? change.after.createdAt : typeof before?.createdAt === "string" ? before.createdAt : at,
            updatedAt: typeof change.after.updatedAt === "string" ? change.after.updatedAt : at,
          };
    // The space's own plugins (step 7) can stop a change, as a browser's can stop a write.
    const name = `data:beforeWrite:${change.collection}`;
    if (hooks.has(name)) {
      const verdict = await root.serial(dispatch, name, { collection: change.collection, id: change.id, before: before ?? undefined, after: after ?? undefined });
      if (verdict && typeof verdict === "object" && "block" in verdict) return { verdict: { ok: false, error: String(verdict.block), version, record: before } };
    }
    // A server plugin may have written the record while its hook ran: then this change is stale too.
    const now = head.versions[key(change.collection, change.id)] ?? 0;
    if (now !== version) return { verdict: { ok: false, stale: true, version: now, record: (await current(change)).record ?? null } };
    // The number is taken before the write, so a plugin's write that lands while this one is applied comes after it, in the log as in the data.
    const accepted: Accepted = { seq: head.seq + 1, collection: change.collection, id: change.id, after, ...(by ? { by } : {}), at };
    head.seq = accepted.seq;
    head.versions[key(change.collection, change.id)] = accepted.seq;
    try {
      await records.apply(change.collection, change.id, after as StoredRecord | null, dispatch);
    } catch (error) {
      announce(accepted.seq, null);
      throw error;
    }
    return { verdict: { ok: true, seq: accepted.seq }, accepted };
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
  }

  // On the server, a write the space's own plugins make (server-apps.ts) is a change like a device's:
  // it takes the next number, goes in the log, and reaches every device.
  if (hosts.mode === "server") {
    // Its number is taken as it is written (this is heard right after the write), not when the log is next
    // free: a device's push waiting on a hook must see it, and come after it.
    records.written.add((change, instance) => {
      const number = () => {
        const accepted: Accepted = { seq: head.seq + 1, collection: change.collection, id: change.id, after: (change.after as SyncRecord | undefined) ?? null, by: `plugin:${instance}`, at: new Date().toISOString() };
        head.seq = accepted.seq;
        head.versions[key(change.collection, change.id)] = accepted.seq;
        return accepted;
      };
      const now = headLoaded ? number() : undefined;
      void serially(async () => {
        await loaded;
        const accepted = now ?? number();
        await record([accepted]);
        announce(accepted.seq, accepted);
      }).catch((error) => trace({ kind: "error", name: "sync:server-write", detail: String(error) }));
    });
  }

  return {
    /** A sync message from a device. */
    async handle(host: Host, message: SyncToSpace & { member?: string }): Promise<void> {
      if (hosts.mode !== "server") return hosts.send(host, { t: "sync", op: "refused", error: "Only a space's kernel answers sync" });
      await loaded;
      if (message.op === "hello") {
        const after = Number.isInteger(message.since) && message.since >= 0 ? message.since : 0;
        // Ordered with pushes, so a change accepted while this device catches up isn't missed or sent twice.
        await serially(async () => {
          // Only what has gone to every device: anything later comes to this one as it does to them.
          hosts.send(host, { t: "sync", op: "changes", changes: (await since(after)).filter((c) => c.seq <= sent), seq: sent });
          listening.add(host);
        });
        return;
      }
      if (message.op === "app") return void onApp?.(message.app);
      if (message.op === "push") {
        const changes = Array.isArray(message.changes) ? message.changes.slice(0, MAX_PUSH) : [];
        const dispatch = { trace: `sync-${message.id}` };
        const results = await serially(async () => {
          const out: Verdict[] = [];
          const accepted: Accepted[] = [];
          for (const change of changes) {
            try {
              const { verdict, accepted: one } = await accept(change, host.member, dispatch);
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
    hostLeft: (host: Host) => void listening.delete(host),
    /** The latest sequence number and the accepted changes after `n`, for checks and tools. */
    since,
  };
}
