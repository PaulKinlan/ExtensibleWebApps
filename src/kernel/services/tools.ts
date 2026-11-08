// The `tools` service: the service methods a plugin may call, described as
// tools a language model can call. It is the first piece of the agent plugin
// (an agent's tools are never hand-written; they come from here), and any
// plugin that talks to `llm` can use it today:
//
//   const tools = await ctx.call("tools", "list");
//   const answer = await ctx.call("llm", "complete", { messages, tools });
//   for (const { name, args } of answer.toolCalls)
//     result = await ctx.call("tools", "call", name, args);
//
// A method is a tool when its service describes its arguments (`params` on
// the method, in remote.ts). `list` offers only what the caller could call
// anyway: a method that needs nothing, or one whose capability the caller's
// manifest grants. A method that takes a collection becomes one tool per
// collection the caller may use (`data_put_books`), with a record argument
// shaped by that collection's schema, so the model sees the real fields; past
// five collections it is one tool whose collection argument lists them.
// `call` checks the arguments against the
// tool's schema and then calls the method through the same gate as
// `ctx.call`, with the same reviews, so a tool can never do more than the
// plugin holding it.
//
// Found by name: this file is src/kernel/services/tools.ts, so it is `ctx.call("tools", …)`.

import { grants } from "../gate";
import { callService, type MethodDoc, type Param, type ServiceProvider } from "../remote";
import { validate, type Schema } from "../schema";
import type { Kernel } from "./index";

/** A tool, in the shape `llm.complete` takes, plus where it goes. */
export interface Tool {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, Schema>; required: string[]; additionalProperties: false };
  service: string;
  method: string;
  reviewed: boolean;
}

/** A collection as the data service lists it. */
type Collection = { name: string; owner: string; title?: string; schema: Schema };

/** Services that are never offered as tools: this one, and the model itself. */
const NOT_TOOLS = new Set(["tools", "llm"]);

/** Up to this many names, a method that takes a name becomes one tool per name. */
const PER_NAME = 5;

const base = (instance: string) => instance.split("@")[0];
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The fixed part of a capability a reader sees as `data:read:<collection>`: `data:read:`. */
const prefixOf = (needs: string) => needs.split("<")[0];

/** True if the caller holds any capability that matches `needs`, read as a pattern. */
function mayNeed(caps: Set<string>, needs: string): boolean {
  if (!needs.includes("<")) return grants(caps, needs);
  const prefix = prefixOf(needs);
  for (const cap of caps) if (cap.startsWith(prefix) || (cap.endsWith("*") && prefix.startsWith(cap.slice(0, -1)))) return true;
  return false;
}

export default ({ remote }: Kernel): ServiceProvider => {
  /**
   * The names a `names` argument may take for this caller, by the gate's own
   * prefix rules; null when a wildcard covers the whole prefix. For `data:`
   * prefixes, the collections the caller owns in the registry count too, and a
   * narrower wildcard (`data:read:public-*`) offers the collections it matches.
   */
  function namesFor(instance: string, caps: Set<string>, prefix: string, collections: Map<string, Collection>): string[] | null {
    const out = new Set<string>();
    const data = prefix.startsWith("data:");
    for (const cap of caps) {
      if (cap.endsWith("*")) {
        const stem = cap.slice(0, -1);
        if (prefix.startsWith(stem)) return null;
        if (stem.startsWith(prefix) && data) for (const name of collections.keys()) if ((prefix + name).startsWith(stem)) out.add(name);
      } else if (cap.startsWith(prefix)) out.add(cap.slice(prefix.length));
    }
    if (data) {
      // A plugin reads and writes the collections it owns, by the registry rather than its manifest's claim.
      for (const c of collections.values()) if (c.owner === base(instance)) out.add(c.name);
      // `notes` belongs to the store service, not a collection, though data:read:notes looks like one.
      out.delete("notes");
    }
    return [...out].sort();
  }

  /** A tool and how to call its method: the method's params, and any values the tool fixes. */
  type Entry = { tool: Tool; params: Param[]; fixed: Record<string, unknown>; records: Set<string> };

  /** A collection's schema as a record argument: its fields, plus the id that replaces a record. */
  const recordSchema = (collection: Collection): Schema => ({
    ...collection.schema,
    type: "object",
    description: `A record of ${collection.title ?? collection.name}; include its id to replace an existing record`,
    properties: { id: { type: "string", description: "The record to replace; leave out for a new one" }, ...(collection.schema.properties ?? {}) },
  });

  async function toolsFor(instance: string, dispatch: { trace?: string }): Promise<Entry[]> {
    const caps = remote.installed.get(base(instance))?.caps ?? new Set<string>();
    const collections = new Map<string, Collection>();
    if (remote.services.data) for (const c of ((await remote.services.data.call(instance, "collections", [], dispatch)) ?? []) as Collection[]) collections.set(c.name, c);
    const entries: Entry[] = [];
    for (const [service, provider] of Object.entries(remote.services)) {
      if (NOT_TOOLS.has(service)) continue;
      for (const [method, doc] of Object.entries(provider.methods) as [string, MethodDoc][]) {
        if (!doc.params) continue;
        const review = doc.reviewed ? " The person may review the change first, so give a reason." : "";
        const make = (name: string, params: Param[], fixed: Record<string, unknown>, about = "") => {
          const properties: Record<string, Schema> = {};
          const records = new Set<string>();
          for (const param of params) {
            if (Object.hasOwn(fixed, param.name)) continue;
            const of = param.recordOf && fixed[param.recordOf];
            if (typeof of === "string" && collections.has(of)) records.add(param.name);
            properties[param.name] = records.has(param.name) ? recordSchema(collections.get(of as string)!) : { ...param.schema };
          }
          const required = params.filter((p) => !p.optional && !Object.hasOwn(fixed, p.name)).map((p) => p.name);
          const tool: Tool = { name, description: `${about}${doc.description} Returns ${doc.returns}.${review}`, parameters: { type: "object", properties, required, additionalProperties: false }, service, method, reviewed: !!doc.reviewed };
          entries.push({ tool, params, fixed, records });
        };
        const named = doc.params.filter((p) => p.names);
        if (!named.length) {
          if (!doc.needs || mayNeed(caps, doc.needs)) make(`${service}_${method}`, doc.params, {});
          continue;
        }
        // A method that takes a name (a collection) is offered for the names the caller may use.
        const lists = named.map((p) => namesFor(instance, caps, p.names!, collections));
        if (lists.some((l) => l !== null && !l.length)) continue;
        const [only] = named;
        const names = lists[0];
        // For a few names, one tool each, so a record argument shows that collection's own fields.
        if (named.length === 1 && names && names.length <= PER_NAME && names.every((n) => `${service}_${method}_${n}`.length <= 64)) {
          for (const n of names) make(`${service}_${method}_${n}`, doc.params, { [only.name]: n }, `For ${collections.get(n)?.title ?? n} (${only.name} ${n}). `);
          continue;
        }
        make(`${service}_${method}`, doc.params.map((p, i) => (p.names && lists[named.indexOf(p)] ? { ...p, schema: { ...p.schema, enum: lists[named.indexOf(p)]! } } : p)), {});
      }
    }
    return entries;
  }

  return {
    description: "The service methods the caller may call, described as tools a language model can call, and a way to call one. The first piece of the agent plugin.",
    methods: {
      list: {
        args: "()",
        returns: "[{ name, description, parameters, service, method, reviewed }]",
        description: "The caller's tools: each service method that describes its arguments and that the caller's manifest lets it call. Pass them to `llm.complete` as `tools`. A method that takes a collection is one tool per collection the caller may use, such as `data_put_books` with that collection's fields (one tool listing them, past five).",
      },
      call: {
        args: "(name, args)",
        returns: "what the method returns",
        description: "Calls a tool from `list` with the arguments a model gave, as an object. The arguments are checked against the tool's schema, then the method is called through the gate, needing what it needs and with the same reviews as `ctx.call`.",
      },
    },
    capability: () => undefined,
    call: async (instance, method, args, dispatch) => {
      if (method === "list") return (await toolsFor(instance, dispatch)).map((e) => e.tool);
      if (method !== "call") throw new Error(`tools.${method} is not a method`);
      const [name, input] = args;
      const entry = (await toolsFor(instance, dispatch)).find((e) => e.tool.name === name);
      if (!entry) throw new Error(`No tool named ${String(name)}`);
      const tool = entry.tool;
      const given = input ?? {};
      if (!isObject(given)) throw new Error(`${tool.name} takes its arguments as an object`);
      const unknown = Object.keys(given).filter((key) => !Object.hasOwn(tool.parameters.properties, key));
      if (unknown.length) throw new Error(`${tool.name} has no argument ${unknown.join(", ")}`);
      // Present is enough for a required argument: "" and null are values a method may take (an empty file, a removed key).
      const missing = tool.parameters.required.filter((key) => !Object.hasOwn(given, key) || given[key] === undefined);
      if (missing.length) throw new Error(`${tool.name}: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required`);
      // A record is checked as the collection checks it; any other argument only needs its required parts present.
      // Like the data service, a record's cleared fields (null or "") are dropped before it is checked.
      const cleared = (value: unknown) => (isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== "")) : value);
      const errors = Object.entries(given).flatMap(([key, value]) => (entry.records.has(key) ? validate(tool.parameters.properties[key], cleared(value), key) : validate(tool.parameters.properties[key], value, key, true)));
      if (errors.length) throw new Error(`${tool.name}: ${errors.map((e) => e.message).join("; ")}`);
      // Positional, in the order the method lists them, with the tool's fixed values, without trailing ones left out.
      const positional = entry.params.map((p) => (Object.hasOwn(entry.fixed, p.name) ? entry.fixed[p.name] : given[p.name]));
      while (positional.length && positional.at(-1) === undefined) positional.pop();
      const caps = remote.installed.get(base(instance))?.caps ?? new Set<string>();
      return callService(remote.services, instance, caps, tool.service, tool.method, positional, dispatch);
    },
  };
};
