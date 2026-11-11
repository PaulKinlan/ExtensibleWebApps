// The seams: everything a space kernel needs from the machine it runs on,
// each as one small interface. A host (Cloudflare, Node, or memory for tests)
// provides each seam, and a space's config can mix providers. Plugins never
// see a seam: they call services through the gate, and the kernel calls these.
//
// Every provider must pass the same checks, in tests/seams/. The browser's
// kernel keeps its folder through the same files seam (opfs.ts), so the store
// reads and writes the same way on every host.

/** The kernel's folder: plugins, their files, settings, reviews, as paths like `plugins/notes.js`. */
export interface Files {
  read(path: string): Promise<Uint8Array | null>;
  readText(path: string): Promise<string | null>;
  write(path: string, data: Uint8Array | string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Every path under a folder (`plugins/`), sorted; "" lists everything. */
  list(prefix: string): Promise<string[]>;
}

/** A record as a space keeps it: its fields, and the sequence number of the change that last wrote it. */
export interface Stored {
  id: string;
  version: number;
  value: Record<string, unknown>;
}

/** One accepted change, in the order the space accepted it. A delete has no `after`. */
export interface Change {
  seq: number;
  collection: string;
  id: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** Why a write was refused: it was based on a version that is no longer the current one. */
export interface Stale {
  ok: false;
  stale: true;
  current: Stored | null;
}

/**
 * Collections of records, and the order changes happened in. `base` is the version the writer last saw
 * (0 for "it shouldn't exist yet"); leave it out to write regardless. Each accepted change gets the next
 * sequence number, which is also the record's new version, so `changes(since)` lets a device catch up.
 */
export interface Records {
  get(collection: string, id: string): Promise<Stored | null>;
  list(collection: string): Promise<Stored[]>;
  put(collection: string, id: string, value: Record<string, unknown>, base?: number): Promise<{ ok: true; seq: number } | Stale>;
  remove(collection: string, id: string, base?: number): Promise<{ ok: true; seq: number } | Stale | { ok: false; stale: false; missing: true }>;
  /** Changes after `since`, oldest first, at most `limit` (default 500). */
  changes(since: number, limit?: number): Promise<Change[]>;
}

/** A job the schedule runs: once `at` a time (ms since 1970), then every `every` ms if set. */
export interface Job {
  name: string;
  at: number;
  every?: number;
}

/**
 * Wakes the space later, even if it was asleep (a Durable Object alarm, a timer restored on start). Jobs
 * survive a restart. A job that came due while the host was down runs once when it starts again.
 */
export interface Schedule {
  set(job: Job): Promise<void>;
  cancel(name: string): Promise<void>;
  list(): Promise<Job[]>;
  /** Who to tell when a job comes due. Set once by the kernel. */
  onDue(handler: (name: string) => void | Promise<void>): void;
  /** Stops the timers, for a host that is shutting down. */
  stop(): void;
}

/** Keys the deployment holds (API keys, SMTP passwords). Only the kernel reads them, to fill in a request. */
export interface Secrets {
  get(name: string): Promise<string | undefined>;
  names(): Promise<string[]>;
}

export interface Message {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

/** Sends email. A development host may only write it down. */
export interface Email {
  send(message: Message): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
}

/**
 * Starts plugins' code for a space's kernel, each in a sandbox of its own: no files, no other
 * process, and no network unless `network`. The port speaks what a plugin's worker speaks in a
 * browser (src/sandbox/runtime.ts).
 */
export interface Isolates {
  /** Resolves to the kernel's end of the plugin's channel: a MessagePort where the host has them. */
  start(name: string, source: string, options: { network: boolean }): Promise<IsolatePort>;
  stop(name: string): void;
  /** Stops them all, for a host that is shutting down. */
  stopAll(): void;
}

/** A MessagePort, as far as a seam needs to say (the seams are typed without the browser's types). */
export interface IsolatePort {
  postMessage(message: unknown): void;
  close(): void;
}

/** What a host provides. A space kernel is built on one of these. */
export interface Seams {
  files: Files;
  records: Records;
  schedule: Schedule;
  secrets: Secrets;
  email: Email;
}

/** A path inside the folder: no leading slash, no `..`, no empty parts. Shared by every provider. */
export function checkPath(path: string): string {
  if (typeof path !== "string" || !path || path.length > 512 || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\")))
    throw new Error(`Not a path in the folder: ${JSON.stringify(path)}`);
  return path;
}

/** A notification a space's server sends its members' devices, and what came of it. */
export interface PushAsk {
  title: string;
  body?: string;
  tag?: string;
  always?: boolean;
  /** The app it is from, as its folder on the site (`demos/household`). */
  app?: string;
  /** Members' ids: only these get it. */
  to?: string[];
}
export interface Pushed {
  sent: number;
  devices: number;
  people: number;
  reached: number;
  problems: string[];
}
