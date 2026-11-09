// The `transfer` service. Import and export for the person: a collection out
// to a CSV or JSON file they keep, open in a spreadsheet or take to another
// app, and a file they choose (a bank's statement, a list from a spreadsheet,
// an earlier export) into a collection.
// A kernel module (docs/layers.md): a site that lists `transfer` in kernel.json has it, as `ctx.call("transfer", …)`.
//
// The page does what only a page can (src/host/bridges/transfer.ts): the
// browser's file chooser, and saving a download. The kernel does the rest:
// it reads the collection, writes the file, and for an import, reads the
// file's columns into the collection's fields, by name or title (a column
// "Item" or "item" fills `item`), turns text into numbers, yes/no and choices
// as the schema asks, and checks every row before writing any.
//
// An import is reviewed once, as a whole ("Import 12 records into Expenses
// from bank.csv"), with the rows it would write, and then every row is
// written as any write is: data:beforeWrite listeners can stop one, and Undo
// takes them back. A row with an id that is already in the collection
// replaces that record, so importing an export puts it back as it was.
//
// Each app sees only its own plugins' collections, as with `history`. The
// file chooser opens only right after the person clicks, so a plugin calls
// `import` from a button.

import { formatCsv, parseCsv, unguard } from "./csv";
import { RECORD_FIELDS, type Fields } from "../../src/kernel/records";
import { validate, type Schema } from "../../src/kernel/schema";
import { record } from "../../src/kernel/trace";
import type { Host } from "../../src/kernel/hosts";
import { service, type ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";

/** The largest file an import reads, and the most rows it writes. */
const MAX_BYTES = 5_000_000;
const MAX_ROWS = 2_000;
/** How many rows the review shows. */
const SHOWN = 20;

type Format = "csv" | "json";
const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A value from a file, as the field's schema wants it: "£1,250.00" for a number is 1250, "yes" for a
 * boolean is true. Text for a text field is kept as written, spaces and all; from a CSV file, only the
 * ' a spreadsheet guard put in front of a formula-like value comes off.
 */
function coerce(value: unknown, schema: Schema, csv: boolean): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return value;
  if (csv) value = unguard(value);
  const text = (value as string).trim();
  if (text === "") return undefined;
  switch (schema.type) {
    case "number":
    case "integer": {
      const negative = /^\(.*\)$/.test(text);
      const digits = text.replace(/[()\s£$€¥,]/g, "");
      const n = Number(digits);
      // "£" alone is no number, not 0.
      return digits !== "" && Number.isFinite(n) ? (negative ? -n : n) : value;
    }
    case "boolean":
      if (/^(true|yes|y|1|x|✓)$/i.test(text)) return true;
      if (/^(false|no|n|0)$/i.test(text)) return false;
      return value;
    case "array":
    case "object":
      try {
        return JSON.parse(text);
      } catch {
        return value;
      }
    default:
      return schema.enum?.find((choice) => typeof choice === "string" && choice.toLowerCase() === text.toLowerCase()) ?? value;
  }
}

/**
 * A file's rows, in order, as objects of text (CSV) or values (JSON): a JSON array, or an object of
 * records by id as a collection is kept. An entry that isn't an object stays in its place as null,
 * so rows keep their numbers and it is reported as skipped.
 */
function rowsOf(name: string, text: string): { csv: boolean; rows: (Record<string, unknown> | null)[] } {
  const json = /\.json$/i.test(name) || /^\s*[[{]/.test(text);
  const isRecord = (r: unknown): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r);
  if (json) {
    const data = JSON.parse(text) as unknown;
    const list = Array.isArray(data) ? data : isRecord(data) ? Object.entries(data).map(([id, r]) => (isRecord(r) ? { id, ...r } : r)) : [];
    return { csv: false, rows: list.map((r) => (isRecord(r) ? r : null)) };
  }
  const [header = [], ...lines] = parseCsv(text);
  return { csv: true, rows: lines.map((line) => Object.fromEntries(header.map((h, i) => [h.trim(), line[i] ?? ""]))) };
}

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { root, hosts, apps, collections, reviewed } = kernel;
  kernel.hook("transfer:changed", {
    mode: "emit",
    needs: "transfer",
    args: "{}",
    description: "A record in a collection transfer.collections listed was written or deleted, so the counts may have changed: call transfer.collections() again.",
  });
  /** The collections whose changes are passed on as transfer:changed, once each has been listed. */
  const watched = new Set<string>();
  const watch = (name: string) => {
    if (watched.has(name)) return;
    watched.add(name);
    // It names no collection: every plugin with `transfer` hears it, so it says only that something changed.
    root.on(`data:changed:${name}`, () => root.emit({}, "transfer:changed", {}));
  };

  /** The plugins in the caller's app: for a tab's instance, only the app open in its tab (as in history.ts). */
  const nearOf = (instance: string) => {
    const tab = instance.split("@")[1];
    return tab ? new Set(apps.linkedBy(tab) ?? []) : apps.alongside(instance);
  };
  /** Whether a collection is owned by a plugin in the caller's app (any, for a plugin no app links). */
  const mine = (instance: string, name: unknown) => {
    const collection = typeof name === "string" ? collections.registry.get(name) : undefined;
    if (!collection) throw new Error(`No collection named ${String(name)}`);
    const near = nearOf(instance);
    if (near && !near.has(collection.owner)) throw new Error(`${collection.title} isn't part of this app`);
    return collection;
  };

  /** The tab to open the chooser or save the file in: the caller's own, or the first with its app open. */
  function tabOf(instance: string): Host {
    const [id, tab] = instance.split("@");
    const host = hosts.list.find((h) => (tab ? h.tab === tab : apps.linkedBy(h.tab)?.includes(id))) ?? (apps.alongside(instance) ? undefined : hosts.list[0]);
    if (!host) throw new Error(`No tab has ${id}'s app open`);
    return host;
  }

  /** The columns of an export: the id, the schema's fields in order, then when it was made and changed. */
  const columns = (schema: Schema) => ["id", ...Object.keys(schema.properties ?? {}), "createdAt", "updatedAt"];

  async function exportTo(instance: string, name: unknown, format: unknown, dispatch: { trace?: string }) {
    const collection = mine(instance, name);
    const as: Format = format === "json" ? "json" : "csv";
    const records = await collections.records(collection.name);
    const header = columns(collection.schema);
    const text = as === "json" ? JSON.stringify(records, null, 2) + "\n" : formatCsv(header, records.map((r) => header.map((k) => r[k])));
    const file = `${(collection.title || collection.name).replace(/[^\w -]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "records"}-${new Date().toISOString().slice(0, 10)}.${as}`;
    await hosts.bridge("transfer", "save", [file, text, as === "json" ? "application/json" : "text/csv"], dispatch, tabOf(instance));
    record({ kind: "note", name: "transfer:export", plugin: instance, trace: dispatch.trace, detail: `${records.length} from ${collection.title} to ${file}` });
    return { ok: true, file, count: records.length };
  }

  async function importFrom(instance: string, name: unknown, reason: unknown, dispatch: { trace?: string }) {
    const collection = mine(instance, name);
    const picked = (await hosts.bridge("transfer", "pick", [".csv,.json,text/csv,application/json", MAX_BYTES], dispatch, tabOf(instance))) as { name: string; size: number; text?: string } | null;
    if (!picked) return { ok: false, cancelled: true, error: "No file was chosen" };
    if (typeof picked.text !== "string") return { ok: false, file: picked.name, error: `${picked.name} is over ${MAX_BYTES / 1_000_000} MB` };

    let rows: (Record<string, unknown> | null)[];
    let csv: boolean;
    try {
      ({ rows, csv } = rowsOf(picked.name, picked.text));
    } catch (error) {
      return { ok: false, file: picked.name, error: `${picked.name} isn't CSV or JSON that can be read: ${error instanceof Error ? error.message : error}` };
    }
    if (rows.length > MAX_ROWS) return { ok: false, file: picked.name, error: `${picked.name} has ${rows.length} rows; an import takes at most ${MAX_ROWS}` };

    // Each column goes to the field with its name or title, matched loosely ("Repeats monthly" fills `repeats`).
    const properties = collection.schema.properties ?? {};
    const fieldOf = new Map<string, string>();
    for (const [key, schema] of Object.entries(properties)) for (const label of [key, schema.title]) if (label && !fieldOf.has(loose(label))) fieldOf.set(loose(label), key);
    const existing = new Map((await collections.records(collection.name)).map((r) => [r.id, r]));
    const ignored = new Set<string>();
    const ready: { row: number; id?: string; fields: Fields }[] = [];
    const skipped: { row: number; error: string }[] = [];
    rows.forEach((row, i) => {
      if (!row) return void skipped.push({ row: i + 1, error: "It isn't a record" });
      const fields: Fields = Object.create(null);
      let id: string | undefined;
      for (const [column, value] of Object.entries(row)) {
        if (loose(column) === "id") {
          if (typeof value === "string" && /^[\w-]{1,64}$/.test(value.trim())) id = value.trim();
          continue;
        }
        if (RECORD_FIELDS.some((f) => loose(f) === loose(column))) continue;
        const key = fieldOf.get(loose(column));
        if (!key) {
          ignored.add(column);
          continue;
        }
        const typed = coerce(value, properties[key], csv);
        if (typed !== undefined) fields[key] = typed;
      }
      const errors = validate({ ...collection.schema, type: "object" }, fields);
      if (errors.length) skipped.push({ row: i + 1, error: errors.map((e) => e.message).join(". ") });
      else ready.push({ row: i + 1, id, fields });
    });
    const base = { file: picked.name, skipped, ignored: [...ignored] };
    if (!ready.length) return { ok: false, ...base, error: rows.length ? `None of the ${rows.length} rows in ${picked.name} fit ${collection.title}` : `${picked.name} has no rows` };

    // One review for the whole import, showing what it writes.
    const replacing = ready.filter((r) => r.id && existing.has(r.id)).length;
    const shown = ready.slice(0, SHOWN).map((r) => (r.id ? { id: r.id, ...r.fields } : { ...r.fields }));
    const more = ready.length > SHOWN ? `\n…and ${ready.length - SHOWN} more` : "";
    const what = `${ready.length} record${ready.length === 1 ? "" : "s"} into ${collection.title} from ${picked.name}${replacing ? ` (replacing ${replacing})` : ""}`;
    try {
      await reviewed(instance, `data:${collection.name}`, what, "", JSON.stringify(shown, null, 2) + more, reason ?? `Import ${what}`, dispatch);
    } catch (error) {
      return { ok: false, ...base, error: error instanceof Error ? error.message : String(error) };
    }

    let added = 0;
    let replaced = 0;
    // The person reviewed the import against the collection as it was: a record with a row's id
    // that was changed, made or deleted while the card was open is left as it now is.
    const now = new Map((await collections.records(collection.name)).map((r) => [r.id, r]));
    for (const { row, id, fields } of ready) {
      if (id && JSON.stringify(now.get(id)) !== JSON.stringify(existing.get(id))) {
        skipped.push({ row, error: "That record changed while the review was open" });
        continue;
      }
      // A full collection or a failed save stops that row, not the report.
      const result = (await collections.write(instance, collection.name, id, fields, reason, dispatch, true).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))) as { ok: boolean; errors?: { message: string }[]; error?: string };
      if (!result.ok) skipped.push({ row, error: result.error ?? (result.errors ?? []).map((e) => e.message).join(". ") });
      else if (id && existing.has(id)) replaced++;
      else added++;
    }
    skipped.sort((a, b) => a.row - b.row);
    record({ kind: "note", name: "transfer:import", plugin: instance, trace: dispatch.trace, detail: `${added} added, ${replaced} replaced, ${skipped.length} skipped in ${collection.title} from ${picked.name}` });
    return { ok: true, ...base, added, replaced };
  }

  return {
    description: "Import and export for the person: a collection of the app's to a CSV or JSON file, and a file they choose into a collection.",
    methods: {
      collections: {
        args: "()",
        returns: "[{ name, title, count, fields }]",
        needs: "transfer",
        params: [],
        description: "The collections the caller's app's plugins own, which it can import into and export, with how many records each has and its fields.",
      },
      export: {
        args: "(collection, format?)",
        returns: "{ ok, file, count }",
        needs: "transfer",
        params: [
          { name: "collection", schema: { type: "string", description: "The collection's name" } },
          { name: "format", schema: { type: "string", enum: ["csv", "json"], description: "csv (the default) for a spreadsheet, json to keep every value as it is" }, optional: true },
        ],
        description: "Saves every record in the collection to a file the person downloads, such as expenses-2026-11-08.csv: a column for the id, each field, and when it was made and changed.",
      },
      import: {
        args: "(collection, reason?)",
        returns: "{ ok, file, added, replaced, skipped: [{ row, error }], ignored: [column] } or { ok: false, cancelled?, error }",
        needs: "transfer",
        reviewed: true,
        params: [
          { name: "collection", schema: { type: "string", description: "The collection's name" } },
          { name: "reason", schema: { type: "string", description: "Why, in a sentence the person reads when they review the import" }, optional: true },
        ],
        description: "Asks the person for a CSV or JSON file and adds its rows to the collection, after one review of them all. Columns match fields by name or title; rows that don't fit the schema are skipped and listed; a row whose id is in the collection replaces that record. Only right after the person clicks, as the browser opens a file chooser only then.",
      },
    },
    capability: () => "transfer",
    call: async (instance, method, args, dispatch) => {
      await collections.ready;
      if (method === "collections") {
        const near = nearOf(instance);
        const out = [];
        for (const c of collections.registry.values()) {
          if (near && !near.has(c.owner)) continue;
          watch(c.name);
          out.push({ name: c.name, title: c.title, count: (await collections.records(c.name)).length, fields: Object.keys(c.schema.properties ?? {}) });
        }
        return out;
      }
      if (method === "export") return exportTo(instance, args[0], args[1], dispatch);
      if (method === "import") return importFrom(instance, args[0], args[1], dispatch);
      throw new Error(`transfer.${method} is not a method`);
    },
  };
};

export default service("transfer", make);
