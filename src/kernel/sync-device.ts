// A device's side of sync (src/shared/sync.ts says how it works): a kernel in
// a browser that keeps a copy of a space (a page at /s/<space>/…) connects to
// the space's kernel, sends the records changed here, and applies the changes
// the space accepted from everyone else. It works on its own copy offline,
// keeps what it changed, and sends it when it's back.
//
// A change the space refuses as stale (someone changed the record first) is
// replaced here by the space's record, and this device's version is kept as a
// draft, so nothing anyone typed is lost.
//
// Kept in the space's copy, beside its collections:
//   sync/device.json   the last sequence number seen, each record's version, changes not yet sent, and drafts

import type { Accepted, Outgoing, SyncRecord, SyncToDevice, Verdict } from "../shared/sync";
import type { Hosts } from "./hosts";
import type { Change, Collections, StoredRecord } from "./records";
import type { Store } from "./store";
import { record as trace } from "./trace";

const STATE = "sync/device.json";
const MAX_PUSH = 100;
const key = (collection: string, id: string) => `${collection}/${id}`;
/** Whether two versions of a record say the same, apart from when each was made. */
const same = (a: SyncRecord | null, b: SyncRecord | null) => {
  const fields = (r: SyncRecord | null) => (r ? JSON.stringify(Object.entries(r).filter(([k]) => k !== "createdAt" && k !== "updatedAt").sort(([x], [y]) => x.localeCompare(y))) : "null");
  return fields(a) === fields(b);
};

export interface Draft {
  /** Names this draft, for keeping or dismissing it. */
  ref: string;
  collection: string;
  id: string;
  /** What this device had made the record, which the space didn't take. */
  mine: SyncRecord | null;
  why: string;
  at: string;
}

/** This kernel's sync, if it keeps a copy of a space, and who hears when what it has changes (services/sync.ts). */
export const thisDevice: { sync?: ReturnType<typeof syncDevice>; changed: Set<() => void> } = { changed: new Set() };
const changed = () => {
  for (const heard of thisDevice.changed) heard();
};

interface State {
  seq: number;
  versions: Record<string, number>;
  pending: Record<string, Outgoing>;
  drafts: Draft[];
}

/** Connects to `url` (the space's kernel) and keeps this kernel's collections in step with it. */
export function syncDevice(url: string, store: Store, records: Collections, hosts: Hosts, { WebSocketImpl = globalThis.WebSocket } = {}) {
  let state: State = { seq: 0, versions: {}, pending: {}, drafts: [] };
  const loaded = store.readJson<unknown>(STATE, null).then((saved) => {
    const s = saved as State | null;
    if (s && typeof s.seq === "number") state = { seq: s.seq, versions: { ...s.versions }, pending: { ...s.pending }, drafts: Array.isArray(s.drafts) ? s.drafts.map((d, i) => ({ ...d, ref: d.ref ?? `d${i}-${d.at}` })) : [] };
  });
  let saving: Promise<unknown> = Promise.resolve();
  const save = () => {
    changed();
    return (saving = saving.then(() => store.writeJson(STATE, state)).catch((error) => trace({ kind: "error", name: "sync:save", detail: String(error) })));
  };

  let socket: WebSocket | undefined;
  /** True once the space has sent what it had: only then are changes pushed, so their versions are current. */
  let caughtUp = false;
  /** The push in flight: its id, and the changes it sent. One at a time. */
  let inFlight: { id: number; changes: Outgoing[] } | undefined;
  let pushes = 0;
  let retry = 1000;
  let stopped = false;
  const status = { connected: false };
  /**
   * Settles once a device new to the space has what the space has, or can't reach it (offline, a few
   * seconds at most): until then its app would see an empty copy, and add sample data the space has
   * already, or has deleted. A device that has synced before has a copy to start from.
   */
  let first: () => void = () => {};
  const ready = new Promise<void>((done) => (first = done));
  void loaded.then(() => state.seq > 0 && first());
  setTimeout(() => first(), 5000);

  // Changes made here: remember them, and send them when connected.
  records.local.add((change: Change) => {
    void loaded.then(() => {
      const k = key(change.collection, change.id);
      const base = state.pending[k]?.base ?? state.versions[k] ?? 0;
      state.pending[k] = { collection: change.collection, id: change.id, base, after: (change.after as SyncRecord | undefined) ?? null };
      save();
      push();
    });
  });

  function push() {
    if (!socket || socket.readyState !== 1 || !caughtUp || inFlight) return;
    const changes = Object.values(state.pending).slice(0, MAX_PUSH);
    if (!changes.length) return;
    inFlight = { id: ++pushes, changes };
    socket.send(JSON.stringify({ t: "sync", op: "push", id: inFlight.id, changes }));
  }

  /**
   * Changes the space accepted, in order: from this device (already here) or another (applied now).
   * The place it has reached moves on only past a change it has: if one can't be put here (the
   * collection is full, saving failed), it stops there, and hears it again when it connects again.
   */
  async function changes(list: Accepted[], seq: number): Promise<boolean> {
    for (const c of list) {
      if (c.seq <= state.seq) continue;
      const k = key(c.collection, c.id);
      const sent = inFlight?.changes.find((o) => key(o.collection, o.id) === k);
      const mine = sent && JSON.stringify(sent.after) === JSON.stringify(c.after);
      const pending = state.pending[k];
      if (mine) {
        // Ours, accepted. A newer edit made here since is now based on this version.
        if (pending && JSON.stringify(pending.after) === JSON.stringify(c.after)) delete state.pending[k];
        else if (pending) pending.base = c.seq;
      } else if (!pending) {
        // Someone else's. (If this device has an unsent change to the same record, it keeps it: the space
        // will refuse it as stale when it's sent, and then the space's record comes here and this one
        // becomes a draft.)
        try {
          await records.apply(c.collection, c.id, c.after as StoredRecord | null, { trace: `sync-${c.seq}` });
        } catch (error) {
          trace({ kind: "error", name: "sync:apply", detail: `${k} (${c.seq}): ${error instanceof Error ? error.message : error}` });
          save();
          return false;
        }
      }
      state.versions[k] = c.seq;
      state.seq = c.seq;
    }
    state.seq = Math.max(state.seq, seq);
    save();
    return true;
  }

  /** Puts the space's record here, as the space answered a push. */
  async function take(collection: string, id: string, record: SyncRecord | null, why: string) {
    try {
      await records.apply(collection, id, record as StoredRecord | null, { trace: `sync-${why}` });
    } catch (error) {
      trace({ kind: "error", name: "sync:apply", detail: `${key(collection, id)}: ${error instanceof Error ? error.message : error}` });
    }
  }

  async function pushed(id: number, results: Verdict[]) {
    if (!inFlight || inFlight.id !== id) return;
    const sent = inFlight.changes;
    inFlight = undefined;
    for (const [i, verdict] of results.entries()) {
      const change = sent[i];
      if (!change) continue;
      const k = key(change.collection, change.id);
      const pending = state.pending[k];
      /** An edit made here while the push was out, which is newer than what was sent. */
      const newer = pending && JSON.stringify(pending.after) !== JSON.stringify(change.after) ? pending : undefined;
      if (verdict.ok) {
        state.versions[k] = Math.max(state.versions[k] ?? 0, verdict.seq);
        if (newer) newer.base = verdict.seq;
        else delete state.pending[k];
        continue;
      }
      // Refused as stale, but the space has what this device made (two devices added the same sample, say): nothing is lost.
      if ("stale" in verdict && same(verdict.record, change.after)) {
        state.versions[k] = verdict.version;
        if (newer) newer.base = verdict.version;
        else {
          delete state.pending[k];
          await take(change.collection, change.id, verdict.record, `same-${id}`);
        }
        continue;
      }
      // Refused: the space's record is put back here, and this device's latest version is kept as a draft.
      const why = "stale" in verdict ? "Someone changed it first" : verdict.error;
      state.drafts.push({ ref: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, collection: change.collection, id: change.id, mine: pending ? pending.after : change.after, why, at: new Date().toISOString() });
      delete state.pending[k];
      if ("record" in verdict && verdict.record !== undefined && typeof verdict.version === "number") {
        state.versions[k] = verdict.version;
        await take(change.collection, change.id, verdict.record, `refused-${id}`);
      }
      trace({ kind: "note", name: "sync:draft", detail: `${change.collection}/${change.id}: ${why}` });
      hosts.broadcast({ t: "notice", text: `${why === "Someone changed it first" ? "Someone else changed this record first" : `The space didn't take a change: ${why}`}. Your version is kept as a draft.`, tone: "error" });
    }
    save();
    push();
  }

  /** What arrives is handled one message at a time, in order, so a change is never passed over while an earlier one is applied. */
  let receiving: Promise<unknown> = Promise.resolve();

  async function receive(ws: WebSocket, data: unknown) {
    // A message from a socket that has closed since is from an earlier connection: this one starts afresh.
    if (socket !== ws) return;
    let m: SyncToDevice;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (m?.t !== "sync") return;
    if (m.op === "changes") {
      const applied = await changes(m.changes, m.seq);
      first();
      if (!applied) return void ws.close();
      if (!caughtUp) {
        caughtUp = true;
        push();
      }
    } else if (m.op === "pushed") await pushed(m.id, m.results);
    else if (m.op === "refused") trace({ kind: "error", name: "sync:refused", detail: m.error });
  }

  function connect() {
    if (stopped) return;
    caughtUp = false;
    inFlight = undefined;
    let ws: WebSocket;
    try {
      ws = new WebSocketImpl(url);
    } catch {
      return void setTimeout(connect, retry);
    }
    socket = ws;
    ws.onopen = async () => {
      await loaded;
      retry = 1000;
      status.connected = true;
      changed();
      ws.send(JSON.stringify({ t: "hello", tab: `sync-${Math.random().toString(36).slice(2, 8)}` }));
      ws.send(JSON.stringify({ t: "sync", op: "hello", since: state.seq }));
      trace({ kind: "lifecycle", name: "sync:connected", detail: `from ${state.seq}, ${Object.keys(state.pending).length} to send` });
    };
    ws.onmessage = (e) => {
      receiving = receiving.then(() => receive(ws, e.data)).catch((error) => trace({ kind: "error", name: "sync:receive", detail: String(error) }));
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = undefined;
      status.connected = false;
      changed();
      first();
      // Offline, or the server restarted: try again, less often each time, up to every half minute.
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30_000);
    };
  }

  connect();

  const space = /\/s\/([^/]+)\/kernel$/.exec(url)?.[1] ?? "";
  const api = {
    status,
    ready,
    /** What this device has, for the page and for checks. */
    async state() {
      await loaded;
      return { space, seq: state.seq, connected: status.connected, pending: Object.keys(state.pending).length, drafts: state.drafts };
    },
    /**
     * Makes a draft the record again, as a change made here: it replaces what the space has now (only
     * if the record is still that), and is sent like any other change. The draft goes once it's done.
     */
    async keep(ref: string, dispatch: { trace?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
      await loaded;
      const draft = state.drafts.find((d) => d.ref === ref);
      if (!draft) return { ok: false, error: "There's no such draft" };
      const now = (await records.record(draft.collection, draft.id)) as StoredRecord | null;
      const mine = draft.mine ? ({ ...draft.mine, updatedAt: new Date().toISOString() } as StoredRecord) : undefined;
      const result = await records.restore(draft.collection, draft.id, now ?? undefined, mine, dispatch);
      if (!result.ok) return { ok: false, error: result.error };
      state.drafts = state.drafts.filter((d) => d.ref !== ref);
      save();
      return { ok: true };
    },
    /** Lets a draft go: the record stays as the space has it. */
    async dismiss(ref: string): Promise<{ ok: boolean }> {
      await loaded;
      const before = state.drafts.length;
      state.drafts = state.drafts.filter((d) => d.ref !== ref);
      if (state.drafts.length !== before) save();
      return { ok: state.drafts.length !== before };
    },
    stop() {
      stopped = true;
      socket?.close();
      if (thisDevice.sync === api) thisDevice.sync = undefined;
    },
  };
  thisDevice.sync = api;
  return api;
}
