// The store: a trusted plugin that provides the `store` service. Notes are
// kept in one JSON file in a folder handle. The host passes the handle in
// (here, the origin private file system) to show that folder handles cross
// into workers; a folder the person picks works the same way.

import { Service } from "cordis";
import type { Dispatch } from "../shared/protocol";
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

export class Store extends Service {
  notes = new Map<string, Note>();
  private dir?: FileSystemDirectoryHandle;
  ready: Promise<void>;
  private open!: (dir: FileSystemDirectoryHandle | undefined) => void;

  constructor(ctx: any) {
    super(ctx, "store");
    this.ready = new Promise<FileSystemDirectoryHandle | undefined>((resolve) => (this.open = resolve)).then((dir) => this.load(dir));
  }

  /** Called once, with the folder handle from the first tab (or nothing, to use this worker's own). */
  use(dir: FileSystemDirectoryHandle | undefined): void {
    this.open(dir);
  }

  private async load(dir: FileSystemDirectoryHandle | undefined): Promise<void> {
    this.dir = dir ?? (await navigator.storage.getDirectory());
    record({ kind: "lifecycle", name: "store:open", detail: dir ? "folder handle from the tab" : "worker's own OPFS" });
    try {
      const file = await (await this.dir.getFileHandle(FILE)).getFile();
      for (const note of JSON.parse(await file.text()) as Note[]) this.notes.set(note.id, note);
    } catch {
      // First run.
    }
  }

  list(): Note[] {
    return [...this.notes.values()].sort((a, b) => b.updated - a.updated);
  }

  get(id: string): Note | undefined {
    return this.notes.get(id);
  }

  /** Writes a note unless a `data:beforeWrite` listener blocks it. */
  async put(note: Note, dispatch: Dispatch = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
    const change: Change = { collection: "notes", id: note.id, before: this.notes.get(note.id), after: note };
    const ctx = this.ctx as any;
    const verdict = await ctx.serial(dispatch, "data:beforeWrite", change);
    if (verdict && typeof verdict === "object" && "block" in verdict) return { ok: false, reason: String(verdict.block) };
    this.notes.set(note.id, note);
    await this.flush();
    ctx.emit(dispatch, "data:changed", change);
    return { ok: true };
  }

  private async flush(): Promise<void> {
    if (!this.dir) return;
    const handle = await this.dir.getFileHandle(FILE, { create: true });
    const writable = await (handle as any).createWritable();
    await writable.write(JSON.stringify(this.list()));
    await writable.close();
  }
}
