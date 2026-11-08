// The `storage` service. Each plugin's own data, never reviewed.
// Found by name: this file is src/kernel/services/storage.ts, so it is `ctx.call("storage", …)`.

import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";

const base = (instance: string) => instance.split("@")[0];
/** A record with no prototype, so keys such as `constructor` or `__proto__` are just keys. */
const record0 = (from: unknown): Record<string, unknown> => Object.assign(Object.create(null), from && typeof from === "object" && !Array.isArray(from) ? from : {});

export default ({ store }: Kernel): ServiceProvider => {
  /** Each plugin's own data: `plugin-data/<id>.json`. */
  const ownData = new Map<string, Promise<Record<string, unknown>>>();
  const dataOf = (id: string) => {
    if (!ownData.has(id)) ownData.set(id, store.readJson<unknown>(`plugin-data/${id}.json`, {}).then(record0));
    return ownData.get(id)!;
  };
  return {
    description: "The plugin's own data, kept in `plugin-data/<id>.json` with the app's data. Never reviewed, since it is the plugin's own.",
    methods: {
      get: { args: "(key)", returns: "the value, or null", description: "Reads a value.", params: [{ name: "key", schema: { type: "string" } }] },
      set: { args: "(key, value)", returns: "true", description: "Saves a JSON value; null removes it. Up to 1 MB in all.", params: [{ name: "key", schema: { type: "string" } }, { name: "value", schema: { description: "Any JSON value; null removes the key" } }] },
    },
    capability: () => undefined,
    call: async (plugin, method, args) => {
      const id = base(plugin);
      const data = await dataOf(id);
      if (typeof args[0] !== "string") throw new Error("Storage keys are strings");
      const key = args[0];
      if (method === "get") return Object.hasOwn(data, key) ? data[key] : null;
      if (method !== "set") throw new Error(`storage.${method} is not a method`);
      // Try the change on a copy first, so a refused write leaves the stored data as it was.
      const next = record0(data);
      if (args[1] === undefined || args[1] === null) delete next[key];
      else Object.defineProperty(next, key, { value: JSON.parse(JSON.stringify(args[1])), enumerable: true, writable: true, configurable: true });
      const text = JSON.stringify(next);
      if (text.length > 1_000_000) throw new Error("A plugin's own storage is limited to 1 MB");
      await store.writeText(`plugin-data/${id}.json`, text);
      for (const k of Object.keys(data)) delete data[k];
      Object.assign(data, next);
      return true;
    },
  };
};
