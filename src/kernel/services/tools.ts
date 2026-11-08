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
// manifest grants. An argument that names a collection lists only the
// collections the caller may use. `call` checks the arguments against the
// tool's schema and then calls the method through the same gate as
// `ctx.call`, with the same reviews, so a tool can never do more than the
// plugin holding it.
//
// Found by name: this file is src/kernel/services/tools.ts, so it is `ctx.call("tools", …)`.

import { grants } from "../gate";
import { callService, type MethodDoc, type ServiceProvider } from "../remote";
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

/** Services that are never offered as tools: this one, and the model itself. */
const NOT_TOOLS = new Set(["tools", "llm"]);

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
  /** The names a `names` argument may take for this caller; null when a wildcard allows any. */
  function namesFor(instance: string, caps: Set<string>, prefix: string): string[] | null {
    const out = new Set<string>();
    for (const cap of caps) {
      if (cap.endsWith("*") && (cap.slice(0, -1).startsWith(prefix) || prefix.startsWith(cap.slice(0, -1)))) return null;
      if (cap.startsWith(prefix)) out.add(cap.slice(prefix.length));
    }
    // A plugin reads and writes the collections it owns without a capability.
    if (prefix.startsWith("data:")) for (const name of Object.keys(remote.installed.get(base(instance))?.manifest.collections ?? {})) out.add(name);
    return [...out].sort();
  }

  function toolsFor(instance: string): Tool[] {
    const caps = remote.installed.get(base(instance))?.caps ?? new Set<string>();
    const tools: Tool[] = [];
    for (const [service, provider] of Object.entries(remote.services)) {
      if (NOT_TOOLS.has(service)) continue;
      for (const [method, doc] of Object.entries(provider.methods) as [string, MethodDoc][]) {
        if (!doc.params) continue;
        const properties: Record<string, Schema> = {};
        // A method that takes a name (a collection) is usable if any name is; others, if the caller may meet `needs`.
        let named: boolean | undefined;
        for (const param of doc.params) {
          const schema: Schema = { ...param.schema };
          if (param.names) {
            const names = namesFor(instance, caps, param.names);
            if (names) schema.enum = names;
            named = (named ?? true) && (names === null || names.length > 0);
          }
          properties[param.name] = schema;
        }
        const usable = named ?? (!doc.needs || mayNeed(caps, doc.needs));
        if (!usable) continue;
        const review = doc.reviewed ? " The person may review the change first, so give a reason." : "";
        tools.push({
          name: `${service}_${method}`,
          description: `${doc.description} Returns ${doc.returns}.${review}`,
          parameters: { type: "object", properties, required: doc.params.filter((p) => !p.optional).map((p) => p.name), additionalProperties: false },
          service,
          method,
          reviewed: !!doc.reviewed,
        });
      }
    }
    return tools;
  }

  return {
    description: "The service methods the caller may call, described as tools a language model can call, and a way to call one. The first piece of the agent plugin.",
    methods: {
      list: {
        args: "()",
        returns: "[{ name, description, parameters, service, method, reviewed }]",
        description: "The caller's tools: each service method that describes its arguments and that the caller's manifest lets it call. Pass them to `llm.complete` as `tools`. An argument that names a collection lists only those the caller may use.",
      },
      call: {
        args: "(name, args)",
        returns: "what the method returns",
        description: "Calls a tool from `list` with the arguments a model gave, as an object. The arguments are checked against the tool's schema, then the method is called through the gate, needing what it needs and with the same reviews as `ctx.call`.",
      },
    },
    capability: () => undefined,
    call: (instance, method, args, dispatch) => {
      if (method === "list") return toolsFor(instance);
      if (method !== "call") throw new Error(`tools.${method} is not a method`);
      const [name, input] = args;
      const tool = toolsFor(instance).find((t) => t.name === name);
      if (!tool) throw new Error(`No tool named ${String(name)}`);
      const given = input ?? {};
      if (!isObject(given)) throw new Error(`${tool.name} takes its arguments as an object`);
      const unknown = Object.keys(given).filter((key) => !Object.hasOwn(tool.parameters.properties, key));
      if (unknown.length) throw new Error(`${tool.name} has no argument ${unknown.join(", ")}`);
      const errors = validate({ type: "object", properties: tool.parameters.properties, required: tool.parameters.required }, given);
      if (errors.length) throw new Error(`${tool.name}: ${errors.map((e) => e.message).join("; ")}`);
      // Positional, in the order the method lists them, without trailing ones left out.
      const positional = Object.keys(tool.parameters.properties).map((key) => given[key]);
      while (positional.length && positional.at(-1) === undefined) positional.pop();
      const caps = remote.installed.get(base(instance))?.caps ?? new Set<string>();
      return callService(remote.services, instance, caps, tool.service, tool.method, positional, dispatch);
    },
  };
};
