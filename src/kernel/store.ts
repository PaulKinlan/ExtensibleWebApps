// The store: a trusted plugin that provides the `store` service. Notes are
// kept in one JSON file in the kernel's folder. The same folder holds the
// plugins installed with the data (`plugins/<id>.js`) and their settings
// (`plugins.json`), so a folder carries its own extensions with it.
//
// The folder is the `files` seam (src/seams/), so the same store works on any
// host. In the browser the host passes a folder handle in (the origin private
// file system, or a folder the person picked), which crosses into workers.

import { Service } from "cordis";
import type { Dispatch } from "../shared/protocol";
import type { Files } from "../seams/index.ts";
import { opfsFiles } from "../seams/opfs.ts";
import { record } from "./trace";

export interface Note {
  id: string;
  title: string;
  text: string;
  updated: number;
}

export interface Change {
  collection: "notes";
  id: string;
  before?: Note;
  after: Note;
}

const FILE = "notes.json";
const PLUGINS = "plugins";

export class Store extends Service {
  notes = new Map<string, Note>();
  private files?: Files;
  ready: Promise<void>;
  private open!: (folder: FileSystemDirectoryHandle | Files | undefined) => void;

  constructor(ctx: any) {
    super(ctx, "store");
    this.ready = new Promise<FileSystemDirectoryHandle | Files | undefined>((resolve) => (this.open = resolve)).then((folder) => this.load(folder));
  }

  /** Called once, with the folder: a handle from the first tab, a files seam from a server host, or nothing for this worker's own. */
  use(folder: FileSystemDirectoryHandle | Files | undefined): void {
    this.open(folder);
  }

  private async load(folder: FileSystemDirectoryHandle | Files | undefined): Promise<void> {
    const handle = (f: typeof folder): f is FileSystemDirectoryHandle => typeof (f as FileSystemDirectoryHandle)?.getFileHandle === "function";
    this.files = folder && !handle(folder) ? folder : opfsFiles(folder ?? (await navigator.storage.getDirectory()));
    record({ kind: "lifecycle", name: "store:open", detail: !folder ? "worker's own OPFS" : handle(folder) ? "folder handle from the tab" : "files from the host" });
    try {
      for (const note of JSON.parse((await this.files.readText(FILE)) ?? "[]") as Note[]) this.notes.set(note.id, note);
    } catch {
      // A notes file that can't be read starts empty, as before.
    }
  }

  list(): Note[] {
    return [...this.notes.values()].sort((a, b) => b.updated - a.updated);
  }

  get(id: string): Note | undefined {
    return this.notes.get(id);
  }

  /**
   * Writes a note unless a `data:beforeWrite` listener blocks it. With
   * `expected` (the text the person reviewed, or null for "no such note"),
   * the write only happens if the note still matches it at that moment.
   */
  async put(note: Note, dispatch: Dispatch = {}, expected?: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
    const change: Change = { collection: "notes", id: note.id, before: this.notes.get(note.id), after: note };
    const ctx = this.ctx as any;
    const verdict = await ctx.serial(dispatch, "data:beforeWrite", change);
    if (verdict && typeof verdict === "object" && "block" in verdict) return { ok: false, reason: String(verdict.block) };
    // Checked after the awaits, right before the write, so nothing can slip in between.
    if (expected !== undefined && (this.notes.get(note.id)?.text ?? null) !== expected) return { ok: false, reason: "the note changed while the review was open" };
    this.notes.set(note.id, note);
    await this.flush();
    ctx.emit(dispatch, "data:changed", change);
    return { ok: true };
  }

  /** Reads a JSON file from the data folder, or `fallback` when there is none. */
  async readJson<T>(name: string, fallback: T): Promise<T> {
    const text = await this.readText(name);
    if (text === undefined) return fallback;
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await this.writeText(name, JSON.stringify(value, null, 2));
  }

  /** Reads a text file at a `/`-separated path in the data folder, or undefined if there is none. Callers check the path. */
  async readText(path: string): Promise<string | undefined> {
    await this.ready;
    try {
      return (await this.files!.readText(path)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Writes a text file at a `/`-separated path in the data folder, creating
   * folders on the way. Writes run one at a time, in the order they were
   * asked for, so an older write never lands after a newer one.
   */
  writeText(path: string, text: string, expected?: string | null): Promise<void> {
    return this.queue(async () => {
      // With `expected` (the contents the person reviewed, or null for "no such file"), only write if the file still matches.
      if (expected !== undefined && ((await this.readText(path)) ?? null) !== expected) throw new Error("The file changed while the review was open; nothing was written");
      await this.files!.write(path, text);
    });
  }

  private writes: Promise<void> = Promise.resolve();

  /** Runs a write after the ones asked for before it. */
  private queue(write: () => Promise<void>): Promise<void> {
    const run = this.writes.then(async () => {
      await this.ready;
      await write();
    });
    this.writes = run.catch(() => {});
    return run;
  }

  /** The names of the files in a folder of the data folder (not in folders inside it), or none if there is no such folder. */
  async listFiles(path: string): Promise<string[]> {
    await this.ready;
    try {
      const prefix = `${path}/`;
      return (await this.files!.list(prefix)).map((p) => p.slice(prefix.length)).filter((name) => name && !name.includes("/"));
    } catch {
      return [];
    }
  }

  /** Writes any file, text or binary (an image a plugin brings), in the same queue as writeText. */
  writeFile(path: string, data: Blob | string): Promise<void> {
    return this.queue(async () => this.files!.write(path, typeof data === "string" ? data : new Uint8Array(await data.arrayBuffer())));
  }

  /** Removes a file; one that is already gone is fine. */
  async removeFile(path: string): Promise<void> {
    await this.ready;
    await this.files!.remove(path);
  }

  /** The sources of the plugins kept in the data folder. */
  async pluginSources(): Promise<string[]> {
    const names = (await this.listFiles(PLUGINS)).filter((name) => name.endsWith(".js"));
    const sources = await Promise.all(names.map((name) => this.files!.readText(`${PLUGINS}/${name}`)));
    return sources.filter((s): s is string => s !== null);
  }

  async savePlugin(id: string, source: string): Promise<void> {
    await this.ready;
    await this.files!.write(`${PLUGINS}/${id}.js`, source);
  }

  async removePlugin(id: string): Promise<void> {
    await this.ready;
    await this.files!.remove(`${PLUGINS}/${id}.js`);
  }

  private async flush(): Promise<void> {
    if (!this.files) return;
    await this.files.write(FILE, JSON.stringify(this.list()));
  }
}
