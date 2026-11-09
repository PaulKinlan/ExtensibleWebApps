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

/** A file of a plugin a member shared with the space (std/spaces/plugins.ts): text, or binary as base64. */
export type SharedFile = { name: string; text: string } | { name: string; base64: string };

/** A plugin the space keeps for an app, as the list names it: `hash` changes whenever any of its files does. */
export interface SharedSummary {
  app: string;
  id: string;
  hash: string;
  /** The member who shared it, or last changed it. */
  by?: string;
  at: string;
}

/** What a device asks of the space about its members' plugins. Each gets a `plugins:reply` with the same id. */
export type PluginRequest =
  | { t: "sync"; op: "plugins"; id: number; action: "list" }
  | { t: "sync"; op: "plugins"; id: number; action: "get"; app: string; plugin: string }
  | { t: "sync"; op: "plugins"; id: number; action: "add"; app: string; files: SharedFile[] }
  | { t: "sync"; op: "plugins"; id: number; action: "remove"; app: string; plugin: string };

/** A change a space's server asks its members to review (std/spaces/reviews.ts), as the card shows it. */
export interface SpaceReview {
  plugin: string;
  name: string;
  place: string;
  target: string;
  before: string;
  after: string;
  reason: string;
  kind?: "place";
  once?: boolean;
}

/** A device's side of a space's reviews: the answer to one, or a request for the ones waiting. */
export type ReviewToSpace =
  | { t: "sync"; op: "review"; action: "answer"; id: string; outcome: "allowed-once" | "allowed-always" | "rejected" }
  | { t: "sync"; op: "review"; action: "waiting" };

/**
 * A member's debugger asks the space's own kernel what runs in it (std/spaces/reflect.ts): one of the reflect
 * service's read-only methods. It gets a `reflect:reply` with the same id.
 */
export type ReflectRequest = { t: "sync"; op: "reflect"; id: number; method: string; args?: unknown[] };

// device -> space
export type SyncToSpace =
  | PluginRequest
  | ReviewToSpace
  | ReflectRequest
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
  | { t: "sync"; op: "changes"; changes: Accepted[]; seq: number; member?: string; members?: Record<string, string> }
  | { t: "sync"; op: "pushed"; id: number; results: Verdict[] }
  | { t: "sync"; op: "refused"; error: string }
  /** The answer to a PluginRequest: the list, one plugin's files, or a shared plugin's new hash. */
  | { t: "sync"; op: "plugins:reply"; id: number; ok: boolean; error?: string; list?: SharedSummary[]; files?: SharedFile[]; hash?: string }
  /** A member shared, changed or removed a plugin: each device asks for the list again. */
  | { t: "sync"; op: "plugins:changed" }
  /** The space's kernel started its sync again (the spaces module restarted): each device says hello again, to catch up and keep hearing changes. */
  | { t: "sync"; op: "again" }
  /** A change the space's server wants reviewed, for a device to show; `done` once anyone answered it, or it ended. */
  | { t: "sync"; op: "review"; action: "ask"; id: string; review: SpaceReview }
  | { t: "sync"; op: "review"; action: "done"; id: string }
  /** The answer to a ReflectRequest: what the space's reflect service returned, or why it couldn't. */
  | { t: "sync"; op: "reflect:reply"; id: number; ok: boolean; value?: unknown; error?: string };
