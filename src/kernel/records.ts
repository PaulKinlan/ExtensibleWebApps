// Collections: typed records that plugins share. A plugin declares a
// collection in its manifest with a JSON Schema; it owns it, and can read and
// write it without asking. Other plugins need `data:read:<collection>` or
// `data:write:<collection>`, and their writes are reviewed first, as any
// write outside a plugin's own data is.
//
// Records live with the app's data as one JSON file per collection
// (`collections/<name>.json`), so they travel with the folder and are easy to
// read. Every write runs `data:beforeWrite:<collection>` (a listener can
// block it) and then `data:changed:<collection>`.
//
// Views can be bound to a collection (`<ui-table collection="books">`,
// `<ui-form collection="books">`). The host asks for the binding on behalf of
// the plugin that drew the view, so it gets exactly that plugin's rights.

import type { Dispatch, Manifest } from "../shared/protocol";
import { defineHook, hooks } from "./hooks";
import type { Host, Hosts } from "./hosts";
import { check, grants } from "./gate";
import type { RemotePlugins, ServiceProvider } from "./remote";
import { validate, type Schema } from "./schema";
import type { Store } from "./store";
import { record as trace } from "./trace";

export interface Collection {
  name: string;
  owner: string;
  title: string;
  schema: Schema;
}

export type Fields = Record<string, unknown>;
export interface StoredRecord extends Fields {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** Field names the kernel keeps for itself on every record. */
export const RECORD_FIELDS = ["id", "createdAt", "updatedAt"];
const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const MAX_RECORDS = 10_000;
const MAX_BYTES = 5_000_000;

/** What `reviewed` in the kernel does: asks the person, throws unless they allow it. */
type Review = (instance: string, place: string, target: string, before: string, after: string, reason: unknown, dispatch: Dispatch) => Promise<string>;

const base = (instance: string) => instance.split("@")[0];
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function collections(root: any, store: Store, hosts: Hosts, remote: RemotePlugins, review: Review) {
  const registry = new Map<string, Collection>();
  const data = new Map<string, Promise<Map<string, StoredRecord>>>();
  /** Bindings from views, by `<tab>/<id>`. */
  const bindings = new Map<string, { host: Host; id: string; owner: string; collection: string }>();

  const load = (name: string) => {
    if (!data.has(name)) {
      data.set(
        name,
        store.readJson<unknown>(`collections/${name}.json`, {}).then((saved) => {
          const out = new Map<string, StoredRecord>();
          if (saved && typeof saved === "object" && !Array.isArray(saved)) for (const [id, r] of Object.entries(saved)) if (r && typeof r === "object") out.set(id, r as StoredRecord);
          return out;
        }),
      );
    }
    return data.get(name)!;
  };

  const save = async (name: string, records: Map<string, StoredRecord>) => {
    const text = JSON.stringify(Object.fromEntries(records), null, 1);
    if (text.length > MAX_BYTES) throw new Error(`The ${name} collection is limited to ${MAX_BYTES / 1_000_000} MB`);
    await store.writeText(`collections/${name}.json`, text);
  };

  /** Called with each plugin's manifest as it is installed, before it starts. */
  function register(manifest: Manifest) {
    for (const [name, spec] of Object.entries(manifest.collections ?? {})) {
      const existing = registry.get(name);
      if (existing && existing.owner !== manifest.id) {
        trace({ kind: "error", name: "collection:taken", plugin: manifest.id, detail: `${name} belongs to ${existing.owner}` });
        continue;
      }
      registry.set(name, { name, owner: manifest.id, title: spec.title ?? name, schema: spec.schema as Schema });
      if (!hooks.has(`data:changed:${name}`)) {
        defineHook(`data:changed:${name}`, { mode: "emit", args: "{ collection, id, before?, after? }", description: `A record in ${name} was written or deleted (after is missing for a delete).` });
        defineHook(`data:beforeWrite:${name}`, { mode: "serial", timeoutMs: 1000, onFailure: "open", args: "{ collection, id, before?, after? }", description: `Before a record in ${name} is written or deleted. Return { block: reason } to stop it.` });
        root.on(`data:changed:${name}`, () => push(name));
      }
    }
  }

  /** The rights a plugin has on a collection: owners have both. */
  const may = (instance: string, name: string, what: "read" | "write") => {
    const plugin = remote.installed.get(base(instance));
    const collection = registry.get(name);
    if (!plugin || !collection) return false;
    return collection.owner === plugin.id || grants(plugin.caps, `data:${what}:${name}`);
  };

  const known = (name: unknown): Collection => {
    const collection = typeof name === "string" ? registry.get(name) : undefined;
    if (!collection) throw new Error(`No collection named ${String(name)}`);
    return collection;
  };

  const sorted = (records: Map<string, StoredRecord>) => [...records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  /** Writes (or, with `fields` null, deletes) a record as `instance`. Reviewed unless the plugin owns the collection. */
  async function write(instance: string, name: string, id: string | undefined, fields: Fields | null, reason: unknown, dispatch: Dispatch) {
    const collection = known(name);
    const records = await load(name);
    const recordId = typeof id === "string" && /^[\w-]{1,64}$/.test(id) ? id : newId();
    const before = records.get(recordId);
    if (fields === null && !before) return { ok: true, id: recordId, unchanged: true };
    let after: StoredRecord | undefined;
    if (fields) {
      const clean: Fields = {};
      for (const [key, value] of Object.entries(fields)) if (!RECORD_FIELDS.includes(key) && value !== undefined) clean[key] = value;
      const errors = validate({ ...collection.schema, type: "object" }, clean);
      if (errors.length) return { ok: false, id: recordId, errors };
      const now = new Date().toISOString();
      after = { ...clean, id: recordId, createdAt: before?.createdAt ?? now, updatedAt: now };
      if (!before && records.size >= MAX_RECORDS) throw new Error(`The ${name} collection is limited to ${MAX_RECORDS} records`);
    }
    let outcome: string | undefined;
    if (collection.owner !== base(instance)) {
      const show = (r?: StoredRecord) => (r ? JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !RECORD_FIELDS.includes(k) || k === "id")), null, 2) : "");
      outcome = await review(instance, `data:${name}`, `${fields ? (before ? "a record" : "a new record") : "and delete a record"} in ${collection.title}`, show(before), show(after), reason, dispatch);
    }
    const change = { collection: name, id: recordId, before, after };
    const verdict = await root.serial(dispatch, `data:beforeWrite:${name}`, change);
    if (verdict && typeof verdict === "object" && "block" in verdict) return { ok: false, id: recordId, error: String(verdict.block) };
    // Checked again after the awaits: the record must still be what was reviewed.
    if (JSON.stringify(records.get(recordId)) !== JSON.stringify(before)) return { ok: false, id: recordId, error: "The record changed while the review was open" };
    if (after) records.set(recordId, after);
    else records.delete(recordId);
    try {
      await save(name, records);
    } catch (error) {
      if (before) records.set(recordId, before);
      else records.delete(recordId);
      throw error;
    }
    root.emit(dispatch, `data:changed:${name}`, change);
    return { ok: true, id: recordId, ...(outcome ? { outcome } : {}) };
  }

  const service: ServiceProvider = {
    description: "Collections: typed records plugins share. A plugin declares its own in its manifest; reading or writing another's needs a capability, and writes to another's are reviewed.",
    methods: {
      collections: { args: "()", returns: "[{ name, owner, title, schema }]", description: "Every collection, with its schema." },
      list: { args: "(collection)", returns: "[record], most recently changed first", needs: "data:read:<collection>", description: "Every record in a collection. Each record has its fields plus id, createdAt and updatedAt." },
      get: { args: "(collection, id)", returns: "record or null", needs: "data:read:<collection>", description: "One record." },
      put: { args: "(collection, { id?, ...fields }, reason?)", returns: "{ ok, id, outcome? } or { ok: false, errors }", needs: "data:write:<collection>", reviewed: true, description: "Creates or replaces a record, checked against the collection's schema. Reviewed unless the plugin owns the collection." },
      delete: { args: "(collection, id, reason?)", returns: "{ ok, id }", needs: "data:write:<collection>", reviewed: true, description: "Deletes a record. Reviewed unless the plugin owns the collection." },
    },
    // Ownership is checked in `call`; the capability is what a non-owner needs.
    capability: () => undefined,
    call: async (instance, method, args, dispatch) => {
      if (method === "collections") return [...registry.values()];
      const name = String(args[0]);
      known(name);
      const what = method === "list" || method === "get" ? "read" : "write";
      if (!may(instance, name, what)) {
        check(instance, new Set(), `data:${what}:${name}`); // traced as denied
        throw new Error(`Missing capability data:${what}:${name}`);
      }
      const records = await load(name);
      if (method === "list") return sorted(records);
      if (method === "get") return records.get(String(args[1])) ?? null;
      if (method === "put") {
        const input = args[1] as Fields | null;
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("data.put takes (collection, { id?, ...fields }, reason?)");
        return write(instance, name, input.id as string | undefined, input, args[2], dispatch);
      }
      return write(instance, name, String(args[1]), null, args[2], dispatch);
    },
  };

  /** Sends each binding of a collection its records again. */
  async function push(name: string) {
    const records = sorted(await load(name));
    for (const b of bindings.values()) if (b.collection === name) hosts.send(b.host, { t: "bound", id: b.id, collection: name, records });
  }

  async function bind(host: Host, id: string, owner: string, name: string) {
    const collection = registry.get(name);
    const key = `${host.tab}/${id}`;
    if (!collection || !may(owner, name, "read")) {
      hosts.send(host, { t: "bound", id, collection: name, error: collection ? `${owner} can't read ${name}` : `No collection named ${name}` });
      if (collection) trace({ kind: "denied", name: `data:read:${name}`, plugin: owner, detail: "bound view" });
      return;
    }
    bindings.set(key, { host, id, owner, collection: name });
    hosts.send(host, { t: "bound", id, collection: name, title: collection.title, schema: collection.schema, writable: may(owner, name, "write"), records: sorted(await load(name)) });
  }

  return {
    service,
    register,
    bind,
    unbind: (host: Host, id: string) => void bindings.delete(`${host.tab}/${id}`),
    hostLeft: (host: Host) => {
      for (const [key, b] of bindings) if (b.host === host) bindings.delete(key);
    },
    /** A bound form or table saved or deleted a record, on behalf of the plugin that drew it. */
    async fromView(host: Host, id: string, owner: string, name: string, recordId: string | undefined, fields: Fields | null, trace: string) {
      try {
        if (!remote.live.has(owner)) throw new Error(`${owner} isn't running`);
        known(name);
        if (!may(owner, name, "write")) throw new Error(`${owner} can't write ${name}`);
        const { id: saved, ...result } = await write(owner, name, recordId, fields, fields ? "Saved from the form" : "Deleted from the table", { trace });
        hosts.send(host, { t: "record:result", id, recordId: saved, ...result });
      } catch (error) {
        hosts.send(host, { t: "record:result", id, ok: false, error: String(error instanceof Error ? error.message : error) });
      }
    },
    registry,
  };
}

export type Collections = ReturnType<typeof collections>;

/** Checks a manifest's `collections`; throws with what is wrong. */
export function checkCollections(value: unknown, checkSchema: (s: unknown, path: string) => void): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("`collections` must be an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 10) throw new Error("At most 10 collections");
  for (const [name, spec] of entries) {
    if (!NAME.test(name) || name === "notes") throw new Error(`Collection ${name}: names are lowercase letters, digits and dashes, and \`notes\` is taken`);
    const s = spec as Record<string, unknown>;
    if (!s || typeof s !== "object") throw new Error(`Collection ${name} must be an object`);
    if (s.title !== undefined && typeof s.title !== "string") throw new Error(`Collection ${name}: title must be a string`);
    checkSchema(s.schema, `collections.${name}.schema`);
    const props = (s.schema as { properties?: Record<string, unknown> }).properties ?? {};
    for (const reserved of RECORD_FIELDS) if (reserved in props) throw new Error(`Collection ${name}: ${reserved} is kept by the kernel`);
  }
}
