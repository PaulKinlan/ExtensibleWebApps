// The `transfer` service. Import and export for the person: a collection out
// to a CSV or JSON file they keep, open in a spreadsheet or take to another
// app, and a file they choose (a bank's statement, a list from a spreadsheet,
// an earlier export) into a collection.
// Found by name: this file is src/kernel/services/transfer.ts, so it is `ctx.call("transfer", …)`.
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

import { formatCsv, parseCsv, unguard } from "../csv";
import { defineHook } from "../hooks";
import { RECORD_FIELDS, type Fields } from "../records";
import { validate, type Schema } from "../schema";
import { record } from "../trace";
import type { Host } from "../hosts";
import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";

/** The largest file an import reads, and the most rows it writes. */
const MAX_BYTES = 5_000_000;
const MAX_ROWS = 2_000;
/** How many rows the review shows. */
const SHOWN = 20;

defineHook("transfer:changed", {
  mode: "emit",
  needs: "transfer",
  args: "{ collection }",
  description: "A record in a collection transfer.collections listed was written or deleted, so its count may have changed.",
});

type Format = "csv" | "json";
const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A value from a file, as the field's schema wants it: "£1,250.00" for a number is 1250, "yes" for a boolean is true. */
function coerce(value: unknown, schema: Schema): unknown {
  if (typeof value === "string") value = unguard(value.trim());
  if (value === "" || value === null || value === undefined) return undefined;
  if (typeof value !== "string") return value;
  switch (schema.type) {
    case "number":
    case "integer": {
      const negative = /^\(.*\)$/.test(value);
      const n = Number(value.replace(/[()\s£$€¥,]/g, ""));
      return Number.isFinite(n) && value !== "" ? (negative ? -n : n) : value;
    }
    case "boolean":
      if (/^(true|yes|y|1|x|✓)$/i.test(value)) return true;
      if (/^(false|no|n|0)$/i.test(value)) return false;
      return value;
    case "array":
    case "object":
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    default:
      return schema.enum?.find((choice) => typeof choice === "string" && choice.toLowerCase() === value.toLowerCase()) ?? value;
  }
}

/** A file's rows as objects of text (CSV) or values (JSON): a JSON array, or an object of records by id as a collection is kept. */
function rowsOf(name: string, text: string): Record<string, unknown>[] {
  const json = /\.json$/i.test(name) || /^\s*[[{]/.test(text);
  if (json) {
    const data = JSON.parse(text) as unknown;
    const list = Array.isArray(data) ? data : data && typeof data === "object" ? Object.entries(data).map(([id, r]) => (r && typeof r === "object" && !Array.isArray(r) ? { id, ...r } : r)) : [];
    return list.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r));
  }
  const [header = [], ...lines] = parseCsv(text);
  return lines.map((line) => Object.fromEntries(header.map((h, i) => [h.trim(), line[i] ?? ""])));
}

export default ({ root, hosts, apps, collections, reviewed }: Kernel): ServiceProvider => {
  /** The collections whose changes are passed on as transfer:changed, once each has been listed. */
  const watched = new Set<string>();
  const watch = (name: string) => {
    if (watched.has(name)) return;
    watched.add(name);
    root.on(`data:changed:${name}`, () => root.emit({}, "transfer:changed", { collection: name }));
  };

  /** Whether a collection is owned by a plugin in the caller's app (any, for a plugin no app links). */
  const mine = (instance: string, name: unknown) => {
    const collection = typeof name === "string" ? collections.registry.get(name) : undefined;
    if (!collection) throw new Error(`No collection named ${String(name)}`);
    const near = apps.alongside(instance);
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

    let rows: Record<string, unknown>[];
    try {
      rows = rowsOf(picked.name, picked.text);
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
        const typed = coerce(value, properties[key]);
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
    for (const { row, id, fields } of ready) {
      const result = (await collections.write(instance, collection.name, id, fields, reason, dispatch, true)) as { ok: boolean; errors?: { message: string }[]; error?: string };
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
        const near = apps.alongside(instance);
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

