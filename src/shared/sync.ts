// Sync between a device and its space: the space orders every change. A device
// sends each record it changed with `base`, the version it last had (0 for one
// it made). When `base` is still the record's version, the space accepts the
// change as the next sequence number. When `base` is older (> 0) and both the
// device and the space changed completely disjoint fields since `base` (with
// neither deleting the record), the space merges the fields into one combined
// record and accepts it. Otherwise a stale change is refused with the record
// as the space has it, so the device shows the newer one and keeps its own as
// a draft. A device that was away asks for the changes since the last sequence
// number it saw.

/** A member's role in a space (src/server/auth/accounts.ts). */
export type SpaceRole = "owner" | "member" | "viewer";

/** A record as it is stored: its fields, with the id and times the kernel keeps. */
export type SyncRecord = Record<string, unknown> & { id: string };

/** A change a device made: the record after it (null for a delete), and the version it was based on. */
export interface Outgoing {
  collection: string;
  id: string;
  base: number;
  /** The record as the device had it at `base`, when known, for 3-way field merge fallback. */
  before?: SyncRecord | null;
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

/** What the space says to each change in a push, in the same order. `merged` carries the combined record when a 3-way field merge succeeded. */
export type Verdict =
  | { ok: true; seq: number; merged?: SyncRecord }
  /** Stale: the space has a newer version, made by `by` (when the space knows who), so the device can say who won without having heard it first. */
  | { ok: false; stale: true; version: number; record: SyncRecord | null; by?: string }
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

/** An app a member made (std/maker) and shared with the space, as the list names it: `hash` changes whenever any of its files does. */
export interface SharedAppSummary {
  name: string;
  /** The title its app.html gives. */
  title: string;
  hash: string;
  /** Its files' names. */
  files: string[];
  /** The member who shared it, or last changed it. */
  by?: string;
  at: string;
}

/** What a device asks of the space about the apps its members made (std/spaces/made-apps.ts). Each gets an `apps:reply` with the same id. */
export type AppRequest =
  | { t: "sync"; op: "apps"; id: number; action: "list" }
  | { t: "sync"; op: "apps"; id: number; action: "get"; name: string }
  | { t: "sync"; op: "apps"; id: number; action: "share"; name: string; files: { name: string; text: string }[] }
  | { t: "sync"; op: "apps"; id: number; action: "unshare"; name: string };

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

/** A live message from a device to its space (std/spaces/live.ts): not kept, heard by the space's plugins as sync:live. */
export type LiveToSpace = { t: "sync"; op: "live"; topic: string; value?: unknown };

/** A member's debugger asks to hear the space's trace as it happens (std/spaces/trace.ts), or to stop. */
export type TraceRequest = { t: "sync"; op: "trace"; on: boolean };

/** Content-addressed binary/media blobs synced across a space (std/spaces/blobs.ts). Each gets a `blobs:reply` with the same id. */
export type BlobRequest =
  | { t: "sync"; op: "blobs"; id: number; action: "put"; hash: string; mediaType: string; size: number; data: string; index?: number; total?: number }
  | { t: "sync"; op: "blobs"; id: number; action: "get"; hash: string; index?: number };

// device -> space
export type SyncToSpace =
  | PluginRequest
  | AppRequest
  | BlobRequest
  | ReviewToSpace
  | ReflectRequest
  | LiveToSpace
  | TraceRequest
  /** Start hearing changes, with every one after `since` first. */
  | { t: "sync"; op: "hello"; since: number }
  | { t: "sync"; op: "push"; id: number; changes: Outgoing[] }
  /** An app was opened in the space (its folder, `demos/reading-list`): its plugins that run on the server start there. */
  | { t: "sync"; op: "app"; app: string };

// space -> device
export type SyncToDevice =
  /**
   * Changes in order. `seq` is the space's latest, so a device knows it has caught up. The first, the
   * answer to hello, says which member the device is signed in as, and their role when known.
   */
  | { t: "sync"; op: "changes"; changes: Accepted[]; seq: number; member?: string; role?: SpaceRole; members?: Record<string, string>; roles?: Record<string, SpaceRole> }
  | { t: "sync"; op: "pushed"; id: number; results: Verdict[] }
  | { t: "sync"; op: "refused"; error: string }
  /** The answer to a PluginRequest: the list, one plugin's files, or a shared plugin's new hash. */
  | { t: "sync"; op: "plugins:reply"; id: number; ok: boolean; error?: string; list?: SharedSummary[]; files?: SharedFile[]; hash?: string }
  /** A member shared, changed or removed a plugin: each device asks for the list again. */
  | { t: "sync"; op: "plugins:changed" }
  /** The answer to an AppRequest: the list, one app's files, or a shared app's new hash. */
  | { t: "sync"; op: "apps:reply"; id: number; ok: boolean; error?: string; list?: SharedAppSummary[]; files?: { name: string; text: string }[]; hash?: string }
  /** A member shared, changed or stopped sharing an app: each device asks for the list again. */
  | { t: "sync"; op: "apps:changed" }
  /** The answer to a BlobRequest: confirms a stored blob or returns its base64 bytes. */
  | { t: "sync"; op: "blobs:reply"; id: number; ok: boolean; error?: string; hash?: string; size?: number; mediaType?: string; data?: string; index?: number; total?: number }
  /** A member stored a new content-addressed blob in the space. */
  | { t: "sync"; op: "blobs:changed"; hash: string; size: number; mediaType: string }
  /** The space's kernel started its sync again (the spaces module restarted): each device says hello again, to catch up and keep hearing changes. */
  | { t: "sync"; op: "again" }
  /** A change the space's server wants reviewed, for a device to show; `done` once anyone answered it, or it ended. */
  | { t: "sync"; op: "review"; action: "ask"; id: string; review: SpaceReview }
  | { t: "sync"; op: "review"; action: "done"; id: string }
  /** The answer to a ReflectRequest: what the space's reflect service returned, or why it couldn't. */
  | { t: "sync"; op: "reflect:reply"; id: number; ok: boolean; value?: unknown; error?: string }
  /** A live message from the space's server plugins (std/spaces/live.ts). */
  | { t: "sync"; op: "live"; topic: string; value: unknown }
  /** New events in the space's trace, for a debugger that asked (std/spaces/trace.ts); `on` says whether it still hears them. */
  | { t: "sync"; op: "trace"; events?: unknown[]; on?: boolean; error?: string };
