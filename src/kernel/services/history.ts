// The `history` service. Undo and redo for the person, across every write to
// an app's collections, whichever plugin made it: a delete in a table, an
// edit in a form, a book a plugin imported, a change an agent made.
// Found by name: this file is src/kernel/services/history.ts, so it is `ctx.call("history", …)`.
//
// The kernel sees every write (records.ts tells it, with the plugin that
// made it), so it keeps the list here, in memory while the app is open: the
// last 100 writes, and what was undone since. Undoing puts the record back as
// it was before the write, without a review, because the person is taking
// back a change that was already made, and only if the record is still what
// the write left: if anything changed it since, that undo is dropped and the
// next one is offered. data:beforeWrite listeners can still stop it.
//
// A plugin calls it for the person, from an Undo button (std/undo.js) or a
// shortcut. Each app sees only the writes to collections its own plugins
// own, so the reading list's Undo never takes back a change to the expenses.
// Undoing and redoing write data the plugin doesn't own without a review, so
// `history` is a permission to give only to a plugin that does it when the
// person asks.

import { defineHook } from "../hooks";
import type { Change } from "../records";
import { record } from "../trace";
import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";

const base = (instance: string) => instance.split("@")[0];

/** How many writes it remembers. */
const KEEP = 100;

defineHook("history:changed", {
  mode: "emit",
  needs: "history",
  args: "{}",
  description: "Something was written, undone or redone, so what Undo and Redo would do may have changed: read history.state().",
});

type Entry = { change: Change; by: string; at: number };

/** What a write did, as a person would say it: `delete “Coffee” in Expenses`. */
export interface Step {
  kind: "add" | "edit" | "delete";
  collection: string;
  /** The collection's title. */
  title: string;
  id: string;
  /** The record's title, name or label, if it has one. */
  label?: string;
  /** The plugin that made the write. */
  by: string;
  at: string;
  /** The whole step in a few words, for a button's title. */
  text: string;
}

export default ({ root, apps, collections }: Kernel): ServiceProvider => {
  const done: Entry[] = [];
  const undone: Entry[] = [];
  const changed = () => root.emit({}, "history:changed", {});

  collections.written.add((change, instance) => {
    done.push({ change, by: base(instance), at: Date.now() });
    if (done.length > KEEP) done.splice(0, done.length - KEEP);
    // A new write to a record makes redoing an older change to it meaningless.
    for (let i = undone.length - 1; i >= 0; i--) if (undone[i].change.collection === change.collection && undone[i].change.id === change.id) undone.splice(i, 1);
    changed();
  });

  /**
   * The plugins in the caller's app. A tab's instance (`undo@<tab>`) has only the app open in its
   * tab, so two apps that both link std/undo.js can't undo each other's changes; a shared instance
   * has every app that links it. Undefined for a plugin no app links.
   */
  const nearOf = (instance: string) => {
    const tab = instance.split("@")[1];
    return tab ? new Set(apps.linkedBy(tab) ?? []) : apps.alongside(instance);
  };
  /** Whether a write is to a collection owned by a plugin in the caller's app (any, for a plugin no app links). */
  const mine = (instance: string, entry: Entry) => {
    const near = nearOf(instance);
    const owner = collections.registry.get(entry.change.collection)?.owner;
    return !near || (!!owner && near.has(owner));
  };
  const last = (list: Entry[], instance: string) => {
    for (let i = list.length - 1; i >= 0; i--) if (mine(instance, list[i])) return i;
    return -1;
  };

  function describe(entry: Entry | undefined): Step | null {
    if (!entry) return null;
    const { change } = entry;
    const kind = !change.before ? "add" : !change.after ? "delete" : "edit";
    const shown = change.after ?? change.before;
    const label = ["title", "name", "item", "label", "description"].map((k) => shown?.[k]).find((v): v is string => typeof v === "string" && v.trim() !== "")?.slice(0, 60);
    const title = collections.registry.get(change.collection)?.title ?? change.collection;
    return { kind, collection: change.collection, title, id: change.id, label, by: entry.by, at: new Date(entry.at).toISOString(), text: `${kind} ${label ? `“${label}”` : "a record"} in ${title}` };
  }

  /** One undo or redo at a time, so two presses can't both pick, or drop, the same step. */
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };

  /**
   * Undoes (or redoes) the caller's app's most recent step, moving it to the other list. A step
   * whose record changed since is dropped, as it can never apply; one that failed for another
   * reason (a listener stopped it, the collection is full, saving failed) stays, to try again.
   */
  async function step(instance: string, from: Entry[], to: Entry[], undo: boolean, dispatch: { trace?: string }) {
    const at = last(from, instance);
    if (at < 0) return { ok: false, error: `Nothing to ${undo ? "undo" : "redo"}` };
    const entry = from[at];
    const { collection, id, before, after } = entry.change;
    const result = await (undo ? collections.restore(collection, id, after, before, dispatch) : collections.restore(collection, id, before, after, dispatch)).catch(
      (error): { ok: false; error: string; stale?: boolean } => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    const what = describe(entry)!;
    record({ kind: "note", name: undo ? "history:undo" : "history:redo", plugin: instance, trace: dispatch.trace, detail: `${what.text}${result.ok ? "" : ` · not done: ${result.error}`}` });
    if (result.ok || ("stale" in result && result.stale)) from.splice(from.indexOf(entry), 1);
    if (result.ok) {
      to.push(entry);
      if (to.length > KEEP) to.splice(0, to.length - KEEP);
    }
    changed();
    return result.ok ? { ok: true, step: what } : { ok: false, step: what, error: result.error };
  }

  return {
    description: "Undo and redo for the person, across every write to the app's collections, whichever plugin made it.",
    methods: {
      state: {
        args: "()",
        returns: "{ undo: step or null, redo: step or null }",
        needs: "history",
        params: [],
        description: "What Undo and Redo would do now in the caller's app. A step is `{ kind, collection, title, id, label?, by, at, text }`, with kind add, edit or delete and text such as `delete “Coffee” in Expenses`.",
      },
      undo: {
        args: "()",
        returns: "{ ok, step } or { ok: false, step?, error }",
        needs: "history",
        params: [],
        description: "Takes back the app's most recent write: the record goes back to how it was, with no review. If the record changed since, that step is dropped and the answer says so; the next undo takes the one before.",
      },
      redo: {
        args: "()",
        returns: "{ ok, step } or { ok: false, step?, error }",
        needs: "history",
        params: [],
        description: "Makes the most recent undone write again. A new write to that record ends its redo.",
      },
    },
    capability: () => "history",
    call: async (instance, method, _args, dispatch) => {
      if (method === "state") return { undo: describe(done[last(done, instance)]), redo: describe(undone[last(undone, instance)]) };
      if (method === "undo") return serially(() => step(instance, done, undone, true, dispatch));
      if (method === "redo") return serially(() => step(instance, undone, done, false, dispatch));
      throw new Error(`history.${method} is not a method`);
    },
  };
};
