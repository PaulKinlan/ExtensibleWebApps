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

import type { Accepted, AppRequest, LiveToSpace, Outgoing, PluginRequest, ReflectRequest, SyncRecord, SyncToDevice, TraceRequest, Verdict } from "../../src/shared/sync";
import type { Hosts } from "../../src/kernel/hosts";
import type { Change, Collections, StoredRecord } from "../../src/kernel/records";
import type { Store } from "../../src/kernel/store";
import { record as trace } from "../../src/kernel/trace";

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

/** This kernel's sync, if it keeps a copy of a space, and who hears when what it has changes (service.ts). */
export const thisDevice: { sync?: ReturnType<typeof syncDevice>; changed: Set<() => void> } = { changed: new Set() };
const changed = () => {
  for (const heard of thisDevice.changed) heard();
};

interface State {
  seq: number;
  /** The space's members' names by id, and which one this device is, as it last said: kept, so a device that's offline still knows them. */
  members?: Record<string, string>;
  member?: string;
  versions: Record<string, number>;
  pending: Record<string, Outgoing>;
  drafts: Draft[];
}

/** Connects to `url` (the space's kernel) and keeps this kernel's collections in step with it. */
export function syncDevice(url: string, store: Store, records: Collections, hosts: Hosts, { WebSocketImpl = globalThis.WebSocket } = {}) {
  let state: State = { seq: 0, versions: {}, pending: {}, drafts: [] };
  /** Who this device is signed in as, once the space has said (its answer to hello). */
  let member: string | undefined;
  const loaded = store.readJson<unknown>(STATE, null).then((saved) => {
    const s = saved as State | null;
    if (s && typeof s.seq === "number") state = { seq: s.seq, ...(s.members && typeof s.members === "object" ? { members: { ...s.members } } : {}), ...(typeof s.member === "string" ? { member: s.member } : {}), versions: { ...s.versions }, pending: { ...s.pending }, drafts: Array.isArray(s.drafts) ? s.drafts.map((d, i) => ({ ...d, ref: d.ref ?? `d${i}-${d.at}` })) : [] };
  });
  void loaded.then(() => (member ??= state.member));
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
  /** Who hears the space's other messages (members' plugins, plugins.ts), and when this device has caught up. */
  const heard = new Set<(message: SyncToDevice) => void>();
  const caughtUpHeard = new Set<() => void>();
  /** The apps opened on this device in the space, which the space hears of each time it connects. */
  const using = new Set<string>();
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
  const local = (change: Change) => {
    void loaded.then(() => {
      const k = key(change.collection, change.id);
      const base = state.pending[k]?.base ?? state.versions[k] ?? 0;
      state.pending[k] = { collection: change.collection, id: change.id, base, after: (change.after as SyncRecord | undefined) ?? null };
      save();
      push();
    });
  };
  records.local.add(local);

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
      } else if (pending) {
        // Someone else's, passed over while this device's own edit waits: who made it is kept, for when the
        // space refuses that edit and its record is put back here.
        passedOver.set(k, { seq: c.seq, by: c.by });
      } else {
        // Someone else's. (If this device has an unsent change to the same record, it keeps it: the space
        // will refuse it as stale when it's sent, and then the space's record comes here and this one
        // becomes a draft.)
        try {
          await records.apply(c.collection, c.id, c.after as StoredRecord | null, { trace: `sync-${c.seq}` }, c.by);
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

  /** Others' changes heard while this device had its own edit to the same record waiting, by record. */
  const passedOver = new Map<string, { seq: number; by?: string }>();

  /** Puts the space's record here, as the space answered a push, saying who made it when this device heard. */
  async function take(collection: string, id: string, record: SyncRecord | null, version: number, why: string, by?: string) {
    const heard = passedOver.get(key(collection, id));
    passedOver.delete(key(collection, id));
    try {
      // Who made it: as heard, or as the space said when it refused this device's change (it may answer before this device hears it).
      await records.apply(collection, id, record as StoredRecord | null, { trace: `sync-${why}` }, heard?.seq === version ? heard.by : by);
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
          await take(change.collection, change.id, verdict.record, verdict.version, `same-${id}`, verdict.by);
        }
        continue;
      }
      // Refused: the space's record is put back here, and this device's latest version is kept as a draft.
      const why = "stale" in verdict ? "Someone changed it first" : verdict.error;
      state.drafts.push({ ref: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, collection: change.collection, id: change.id, mine: pending ? pending.after : change.after, why, at: new Date().toISOString() });
      delete state.pending[k];
      if ("record" in verdict && verdict.record !== undefined && typeof verdict.version === "number") {
        state.versions[k] = verdict.version;
        await take(change.collection, change.id, verdict.record, verdict.version, `refused-${id}`, "stale" in verdict ? verdict.by : undefined);
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
      const was = member;
      if (typeof m.member === "string") member = m.member;
      const names = m.members && typeof m.members === "object" && JSON.stringify(m.members) !== JSON.stringify(state.members ?? null);
      if (names) state.members = { ...m.members! };
      if (names || member !== state.member) {
        if (member) state.member = member;
        save();
      } else if (member !== was) changed();
      const applied = await changes(m.changes, m.seq);
      first();
      if (!applied) return void ws.close();
      if (!caughtUp) {
        caughtUp = true;
        push();
        for (const then of caughtUpHeard) then();
      }
    } else if (m.op === "pushed") await pushed(m.id, m.results);
    else if (m.op === "refused") trace({ kind: "error", name: "sync:refused", detail: m.error });
    else if (m.op === "again") ws.send(JSON.stringify({ t: "sync", op: "hello", since: state.seq }));
    else for (const listener of heard) listener(m);
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
      for (const app of using) ws.send(JSON.stringify({ t: "sync", op: "app", app }));
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
    heard,
    caughtUp: caughtUpHeard,
    /**
     * Sends a request about members' plugins, a debugger's question (reflect.ts) or its asking for the trace
     * (trace.ts), a live message (live.ts), or a request about members' made apps (made-apps.ts), if connected and caught up: whether it went.
     */
    send(message: PluginRequest | ReflectRequest | LiveToSpace | TraceRequest | AppRequest): boolean {
      if (!socket || socket.readyState !== 1 || !caughtUp) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    /** An app opened here: the space starts its plugins that run on the server. */
    use(app: string) {
      if (using.has(app)) return;
      using.add(app);
      if (socket?.readyState === 1) socket.send(JSON.stringify({ t: "sync", op: "app", app }));
    },
    /** What this device has, for the page and for checks. */
    async state() {
      await loaded;
      return { space, ...(member ? { member } : {}), members: { ...(state.members ?? {}) }, seq: state.seq, connected: status.connected, pending: Object.keys(state.pending).length, drafts: state.drafts };
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
      records.local.delete(local);
      first();
      socket?.close();
      if (thisDevice.sync === api) thisDevice.sync = undefined;
    },
  };
  thisDevice.sync = api;
  return api;
}
