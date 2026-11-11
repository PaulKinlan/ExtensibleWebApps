// The `device-model` service: the language model some browsers carry
// themselves. Chrome has one behind its Prompt API: it runs on the person's
// computer, so there is no key to give, nothing to pay, and nothing leaves the
// device. A plugin needs `device-model` to ask it; any plugin may ask whether it is there:
//
//   const { state } = await ctx.call("device-model", "state");   // "available", "downloadable", "downloading" or "unavailable"
//   const { text } = await ctx.call("device-model", "prompt", { system, turns: [{ role: "user", content: "Hello" }] });
//
// Most plugins should ask through `llm` instead, which is the same whoever
// makes the model: std/llm/chrome.js puts this one behind it, as a model
// beside the vendors', offered only where the browser has it.
//
// The browser's API is in pages and not in workers, where this kernel and
// every plugin run, so the asking is a bridge (src/host/bridges/device-model.ts)
// to a tab: the one the person is in, else any with the plugin's app, else any
// tab, since the model is the browser's and the same in each. A space's server
// has no browser, so there it is "unavailable".
//
// A kernel module (docs/layers.md): a site that lists `device-model` in kernel.json has it.

import type { Host } from "../../src/kernel/hosts";
import { service, type ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";
import type { Dispatch } from "../../src/shared/protocol";

/** The most text in one request: far more than the model reads at once, and well under what a message to a tab may carry. */
const MAX = 400_000;
const ROLES = ["system", "user", "assistant"];

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { hosts, apps } = kernel;
  /** The tab to ask in: the one the person acted in (an action's trace starts with its tab), else one with the plugin's app, else any. */
  const tabFor = (instance: string, dispatch: Dispatch): Host | undefined => {
    if (hosts.mode === "server") return undefined;
    const [id, tab] = instance.split("@");
    const from = dispatch.trace?.split("-")[0];
    return hosts.list.find((h) => h.tab === (tab ?? from)) ?? hosts.list.find((h) => apps.linkedBy(h.tab)?.includes(id)) ?? hosts.list[0];
  };

  return {
    description: "The language model the browser carries itself (Chrome's built-in model): no key, and nothing leaves the device. Most plugins ask through llm instead.",
    methods: {
      state: {
        args: "()",
        // No `params`: with them, a method that needs no permission would be a tool every agent is handed (std/tools).
        returns: '{ state: "available" | "downloadable" | "downloading" | "unavailable", progress }',
        description: "Whether this browser has a model of its own, which any plugin may ask (a list of plugins leaves out the ones that need a model the browser hasn't got). downloadable: it can have one, after a download of several GB that the first prompt() starts. progress is how much of a download has arrived, 0 to 1.",
      },
      prompt: {
        args: "({ system?, turns: [{ role, content }], schema? })",
        params: [
          {
            name: "request",
            schema: {
              type: "object",
              properties: {
                system: { type: "string", description: "What the model is told before the conversation" },
                turns: { type: "array", description: "The conversation: { role: \"user\" | \"assistant\", content }, ending with the person's turn" },
                schema: { type: "object", description: "A JSON Schema the answer is held to" },
              },
              required: ["turns"],
            },
          },
        ],
        returns: "{ text, input, output }",
        needs: "device-model",
        description: "Asks the browser's model. input and output are the tokens the request and the answer took, as near as the browser says. While the model is still downloading, the error says how far it has got.",
      },
    },
    capability: (method) => (method === "state" ? undefined : "device-model"),
    async call(instance, method, args, dispatch) {
      const host = tabFor(instance, dispatch);
      if (method === "state") {
        if (!host) return { state: "unavailable", progress: 0 };
        return hosts.bridge("device-model", "state", [], dispatch, host);
      }
      if (method !== "prompt") throw new Error(`device-model.${method} is not a method`);
      if (!host) throw new Error(hosts.mode === "server" ? "A space's server has no browser, so no built-in model. Use a model with a key there." : "No tab is open to ask the browser's model in");
      const request = (args[0] ?? {}) as { system?: unknown; turns?: unknown; schema?: unknown };
      const turns = request.turns;
      if (!Array.isArray(turns) || !turns.length || turns.some((t) => !t || typeof t !== "object" || !ROLES.includes(t.role) || typeof t.content !== "string")) {
        throw new Error("device-model.prompt takes { turns: [{ role, content }] }, with role user or assistant and content text");
      }
      if (turns[turns.length - 1].role !== "user") throw new Error("The last turn is the person's (role user)");
      if (request.system !== undefined && typeof request.system !== "string") throw new Error("system is text");
      if (request.schema !== undefined && (!request.schema || typeof request.schema !== "object")) throw new Error("schema is a JSON Schema object");
      const sent = { ...(request.system ? { system: request.system } : {}), turns: turns.map((t) => ({ role: t.role, content: t.content })), ...(request.schema ? { schema: request.schema } : {}) };
      if (JSON.stringify(sent).length > MAX) throw new Error("That is more than the browser's built-in model can read at once. Ask something shorter, or pick a larger model.");
      return hosts.bridge("device-model", "prompt", [sent], dispatch, host);
    },
  };
};

export default service("device-model", make);
