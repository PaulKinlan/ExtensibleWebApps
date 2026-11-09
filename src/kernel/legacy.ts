// Data the kernel itself wrote in an older layout, carried over to where it
// lives now. Before the notes app became a plugin (site/workbench/plugins/notes.js),
// the kernel kept every note in one `notes.json` at the top of the data folder,
// as [{ id, title, text, updated }]. The notes plugin keeps them in its `notes`
// collection instead, so a folder from before then showed no notes.
//
// The first time the `notes` collection is read and it has no file of its own
// yet, its records come from `notes.json`. The collection's file is written
// straight away, so this runs once per folder; `notes.json` is left where it
// is, so an older copy of the platform still finds it.

import type { StoredRecord } from "./records";
import type { Store } from "./store";
import { record as trace } from "./trace";

interface OldNote {
  id?: unknown;
  title?: unknown;
  text?: unknown;
  updated?: unknown;
}

/** Old files the kernel kept, by the collection (and the plugin that owns it) they now belong to. */
const OLD = [{ file: "notes.json", collection: "notes", owner: "notes" }];

const isoTime = (ms: unknown) => {
  const date = new Date(typeof ms === "number" && Number.isFinite(ms) ? ms : Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};

/**
 * The records for `collection` from an old file, when the collection has no file of its own and is owned by the
 * plugin the old file belonged to. Undefined when there is nothing to carry over.
 */
export async function carryOver(store: Store, collection: string, owner: string | undefined, maxBytes: number): Promise<Map<string, StoredRecord> | undefined> {
  const old = OLD.find((o) => o.collection === collection && o.owner === owner);
  if (!old) return undefined;
  if ((await store.readText(`collections/${collection}.json`)) !== undefined) return undefined;
  const saved = await store.readJson<unknown>(old.file, undefined);
  if (!Array.isArray(saved)) return undefined;
  const all: StoredRecord[] = [];
  for (const note of saved as OldNote[]) {
    if (!note || typeof note !== "object" || typeof note.id !== "string" || !/^[\w-]{1,64}$/.test(note.id) || typeof note.text !== "string") continue;
    const when = isoTime(note.updated);
    const title = (typeof note.title === "string" && note.title.trim() ? note.title : note.text.split("\n")[0].replace(/^#+\s*/, "").trim() || "Untitled").slice(0, 60);
    all.push({ title, text: note.text.slice(0, 100_000), id: note.id, createdAt: when, updatedAt: when });
  }
  if (!all.length) return undefined;
  // A collection has a size limit, and one past it can't be saved, not even to delete a note. Newest first, the notes
  // that fit come over (with room to spare); any left are named in the trace, and stay in the old file.
  const size = (r: StoredRecord) => new TextEncoder().encode(JSON.stringify({ [r.id]: r }, null, 1)).length;
  const out = new Map<string, StoredRecord>();
  let bytes = 0;
  const left: string[] = [];
  for (const r of all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (out.has(r.id)) continue;
    const more = size(r);
    if (bytes + more > maxBytes * 0.9) left.push(r.id);
    else {
      out.set(r.id, r);
      bytes += more;
    }
  }
  if (left.length) trace({ kind: "error", name: "collection:carry-over", plugin: owner, detail: `${left.length} notes in ${old.file} are too big to fit in ${collection} and stay there: ${left.slice(0, 20).join(", ")}` });
  if (!out.size) return undefined;
  await store.writeText(`collections/${collection}.json`, JSON.stringify(Object.fromEntries(out), null, 1));
  trace({ kind: "lifecycle", name: "collection:carried-over", plugin: owner, detail: `${out.size} from ${old.file} into ${collection}` });
  return out;
}
