// Sync between a device and its space, before 2c's CRDTs: the space orders
// every change. A device sends each record it changed with `base`, the
// version it last had (0 for one it made). The space accepts a change only
// when `base` is still the record's version, gives it the next sequence
// number (which becomes the record's version), and sends it to every device.
// A change based on an older version is refused as stale, with the record as
// the space has it, so the device can show the newer one and keep its own as
// a draft. A device that was away asks for the changes since the last
// sequence number it saw.

/** A record as it is stored: its fields, with the id and times the kernel keeps. */
export type SyncRecord = Record<string, unknown> & { id: string };

/** A change a device made: the record after it (null for a delete), and the version it was based on. */
export interface Outgoing {
  collection: string;
  id: string;
  base: number;
  after: SyncRecord | null;
}

/** A change the space accepted, as every device hears it. */
export interface Accepted {
  seq: number;
  collection: string;
  id: string;
  after: SyncRecord | null;
  /** The member who made it, as the space's accounts know them. */
  by?: string;
  at: string;
}

/** What the space says to each change in a push, in the same order. */
export type Verdict =
  | { ok: true; seq: number }
  | { ok: false; stale: true; version: number; record: SyncRecord | null }
  /** Refused for another reason; when the change named a record, the record as the space has it, so the device can put it back. */
  | { ok: false; error: string; version?: number; record?: SyncRecord | null };

// device -> space
export type SyncToSpace =
  /** Start hearing changes, with every one after `since` first. */
  | { t: "sync"; op: "hello"; since: number }
  | { t: "sync"; op: "push"; id: number; changes: Outgoing[] }
  /** An app was opened in the space (its folder, `demos/reading-list`): its plugins that run on the server start there. */
  | { t: "sync"; op: "app"; app: string };

// space -> device
export type SyncToDevice =
  /**
   * Changes in order. `seq` is the space's latest, so a device knows it has caught up. The first, the
   * answer to hello, says which member the device is signed in as.
   */
  | { t: "sync"; op: "changes"; changes: Accepted[]; seq: number; member?: string }
  | { t: "sync"; op: "pushed"; id: number; results: Verdict[] }
  | { t: "sync"; op: "refused"; error: string };
