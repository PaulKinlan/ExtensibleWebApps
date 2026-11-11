// The `llm` service: one way for any plugin to ask a language model, whoever
// makes the model. The platform fixes the interface; vendor plugins plug in
// behind it (std/llm/anthropic.js, std/llm/openai.js, std/llm/gemini.js).
//
//   const answer = await ctx.call("llm", "complete", {
//     system: "You answer in one sentence.",
//     messages: [{ role: "user", content: "What is a kernel?" }],
//   });
//   answer.text   // "A kernel is ..."
//
// A plugin that calls it needs the `llm` permission, and nothing else: it
// never sees a key, and never learns which vendor's API was reached. A vendor
// plugin needs `provide:llm`, the `network:<host>` of its API and the
// `secret:<name>` of its key, which the kernel fills into its requests
// (secrets.ts, net.ts).
//
// Three hooks connect them, all only for plugins with `provide:llm`:
//
// - `llm:providers` (waterfall): each provider adds itself to the list,
//   { id, name, model, ready }, where ready means it has its key.
// - `llm:complete`: the kernel picks a provider and passes the request on
//   with `provider` set to its id; that provider answers, the rest pass.
//   A provider that fails answers { error }, which becomes the caller's error.
// - `llm:models`: the provider named in `provider` lists the models its
//   vendor serves now, and which one each tier stands for.
//
// The request and answer are the same for every vendor:
//
//   request: { messages, system?, tools?, schema?, model?, maxTokens?, provider? }
//     messages: { role: "user" | "assistant", content }
//             | { role: "assistant", content?, toolCalls: [{ id, name, args }], state? }
//             | { role: "tool", id, name, content }      (a tool's answer)
//     tools:    [{ name, description, parameters }]     (JSON Schema for the args)
//     schema:   JSON Schema; the answer's `json` then holds a value of that shape
//     model:    a model's id, or a tier: "best", "balanced" or "fast". A tier
//               is the provider's newest model of that kind, looked up live, so
//               an app keeps up with new models without changing its code.
//   answer:  { text, json?, toolCalls, stop, usage: { input, output }, provider, model, message }
//     stop:    "end" | "tool" | "length" | "refused"
//     message: the model's turn, ready to add to `messages` for the next request.
//              Its `state` is the vendor's own record of the turn (such as the
//              model's reasoning before a tool call), which some vendors need
//              back; pass it on unchanged.
//
// Streaming answers come next, with the chat plugin that needs them.

import { callService, type ServiceProvider } from "../../src/kernel/remote";
import { record } from "../../src/kernel/trace";
import { checkSchema, validate, type Schema } from "../../src/kernel/schema";
import { service, type ModuleKernel } from "../../src/kernel/modules";

const MAX = 4_000_000;
const TOOL = /^[a-zA-Z0-9_-]{1,64}$/;

export interface Provider {
  id: string;
  name: string;
  model?: string;
  ready: boolean;
  /** The one the person picked to answer when a request names none (llm.prefer). */
  preferred?: boolean;
}

export interface LlmRequest {
  messages: { role: "user" | "assistant" | "tool"; content?: string; id?: string; name?: string; toolCalls?: { id: string; name: string; args: unknown }[]; state?: unknown }[];
  system?: string;
  tools?: { name: string; description?: string; parameters?: unknown }[];
  schema?: unknown;
  model?: string;
  maxTokens?: number;
  provider?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Checks a request's shape, so every provider can rely on it, and returns a plain copy. */
export function checkRequest(input: unknown): LlmRequest {
  if (!isObject(input)) throw new Error("llm.complete takes { messages: [...] }");
  const json = JSON.stringify(input);
  if (json.length > MAX) throw new Error("The request is larger than 4 MB");
  const request = JSON.parse(json) as Record<string, unknown>;
  const messages = request.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > 1000) throw new Error("messages is a list of 1 to 1000 messages");
  messages.forEach((m, i) => {
    const where = `messages[${i}]`;
    if (!isObject(m)) throw new Error(`${where} isn't a message`);
    if (m.role === "user") {
      if (typeof m.content !== "string") throw new Error(`${where}: a user message's content is text`);
    } else if (m.role === "assistant") {
      if (m.content !== undefined && typeof m.content !== "string") throw new Error(`${where}: content is text`);
      if (m.toolCalls !== undefined) {
        if (!Array.isArray(m.toolCalls) || m.toolCalls.some((c) => !isObject(c) || typeof c.id !== "string" || typeof c.name !== "string")) throw new Error(`${where}: toolCalls is [{ id, name, args }]`);
      } else if (typeof m.content !== "string" && m.state === undefined) throw new Error(`${where}: an assistant message has content or toolCalls`);
    } else if (m.role === "tool") {
      if (typeof m.id !== "string" || typeof m.name !== "string" || typeof m.content !== "string") throw new Error(`${where}: a tool's answer is { role: "tool", id, name, content }`);
    } else throw new Error(`${where}: role is user, assistant or tool`);
  });
  if (messages[0].role !== "user") throw new Error("The first message is the person's (role user)");
  if (request.system !== undefined && typeof request.system !== "string") throw new Error("system is text");
  if (request.tools !== undefined) {
    const tools = request.tools;
    if (!Array.isArray(tools) || tools.length > 64) throw new Error("tools is a list of up to 64 tools");
    for (const t of tools) {
      if (!isObject(t) || typeof t.name !== "string" || !TOOL.test(t.name)) throw new Error("A tool's name is letters, digits, _ and -, up to 64");
      if (t.description !== undefined && typeof t.description !== "string") throw new Error(`${t.name}: description is text`);
      if (t.parameters !== undefined && !isObject(t.parameters)) throw new Error(`${t.name}: parameters is a JSON Schema object`);
    }
  }
  // The platform's JSON Schema subset (schema.ts), the same as collections use, so the answer can be checked against it.
  if (request.schema !== undefined) checkSchema(request.schema, "schema");
  if (request.model !== undefined && (typeof request.model !== "string" || request.model.length > 100)) throw new Error("model is a model's name");
  if (request.maxTokens !== undefined && (!Number.isInteger(request.maxTokens) || (request.maxTokens as number) < 1 || (request.maxTokens as number) > 128_000)) throw new Error("maxTokens is a whole number from 1 to 128000");
  if (request.provider !== undefined && typeof request.provider !== "string") throw new Error("provider is a provider's id, from llm.providers()");
  return request as unknown as LlmRequest;
}

/** Keeps only what the interface promises, whatever the provider sent back. */
function cleanAnswer(value: Record<string, unknown>, provider: string) {
  const calls = Array.isArray(value.toolCalls) ? value.toolCalls.filter((c): c is Record<string, unknown> => isObject(c) && typeof c.name === "string") : [];
  const usage = isObject(value.usage) ? value.usage : {};
  const stop = ["end", "tool", "length", "refused"].includes(value.stop as string) ? (value.stop as string) : calls.length ? "tool" : "end";
  const answer: Record<string, unknown> = {
    text: typeof value.text === "string" ? value.text : "",
    toolCalls: calls.map((c) => ({ id: typeof c.id === "string" ? c.id : `call-${Math.random().toString(36).slice(2, 10)}`, name: c.name, args: isObject(c.args) ? c.args : {} })),
    stop,
    usage: { input: Number(usage.input) || 0, output: Number(usage.output) || 0 },
    provider,
    model: typeof value.model === "string" ? value.model : "",
  };
  if ("json" in value) answer.json = value.json;
  const message: Record<string, unknown> = { role: "assistant", content: answer.text };
  if (calls.length) message.toolCalls = answer.toolCalls;
  if (value.state !== undefined) message.state = value.state;
  answer.message = message;
  return answer;
}

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { root, apps, remote, store } = kernel;
  /** The provider the person picked to answer when a request names none: theirs, on this device, for every app. */
  const PREFERENCE = "llm.json";
  const preference = async () => (await store.readJson<{ prefer?: string }>(PREFERENCE, {})).prefer;
  kernel.hook("llm:providers", {
    mode: "waterfall",
    timeoutMs: 2000,
    onFailure: "open",
    needs: "provide:llm",
    args: "{ providers: [{ id, name, model?, ready }] }",
    description: "Asks which language models are available. A provider returns { providers: [...providers, itself] }. Listening needs provide:llm.",
  });
  kernel.hook("llm:complete", {
    mode: "bail",
    // Long enough for a slow model, and for the person to paste a key when the provider asks for one.
    timeoutMs: 11 * 60_000,
    onFailure: "open",
    needs: "provide:llm",
    args: "request, with provider set to the id of the provider that should answer",
    description: "Asks the provider named in request.provider for an answer. Others return nothing. Answer { text, json?, toolCalls?, stop?, usage?, model? }, or { error }, with declined: true when the person gave it no key. Listening needs provide:llm.",
  });

  kernel.hook("llm:models", {
    mode: "bail",
    timeoutMs: 30_000,
    onFailure: "open",
    needs: "provide:llm",
    args: "{ provider }",
    description: "Asks the provider named in provider which models its vendor serves. Answer { models: [{ id, name? }], tiers: { best, balanced, fast } }, or { error }. Listening needs provide:llm.",
  });

  /**
   * The providers the caller can use: those its own app links. Provider plugins from other apps
   * open in other tabs run in the same kernel, but aren't this app's to use. A plugin that no app
   * links (one the workbench installed) sees them all.
   */
  async function providers(dispatch: unknown, caller: string): Promise<Provider[]> {
    const mine = apps.alongside(caller);
    const state = { providers: [] as unknown[] };
    await root.waterfall(dispatch, "llm:providers", state, () => state);
    const seen = new Set<string>();
    const out: Provider[] = [];
    for (const p of state.providers) {
      if (!isObject(p) || typeof p.id !== "string" || seen.has(p.id) || (mine && !mine.has(p.id))) continue;
      seen.add(p.id);
      out.push({ id: p.id, name: typeof p.name === "string" ? p.name : p.id, model: typeof p.model === "string" ? p.model : undefined, ready: p.ready === true });
    }
    const prefer = await preference();
    for (const p of out) if (p.id === prefer) p.preferred = true;
    return out;
  }

  /**
   * The site's language models a person can add to the caller's app: the registry's packages
   * (/packages/index.json) that ask for provide:llm. Adding one goes through the authoring service as the
   * caller, with only the rights this needs, so the person still accepts a review of the model plugin's code,
   * and the plugin is theirs: on this device, never in the app's files. It is kept for every app they open
   * (user-plugins.ts), so a model and its key are added once.
   */
  async function offered(plugin: string, dispatch: unknown, method: "choices" | "add", id?: unknown) {
    const as = (right: string, name: string, args: unknown[]) => callService(remote.services, plugin, new Set([right]), "authoring", name, args, dispatch as { trace?: string }) as Promise<any>;
    let models = ((await as("plugins:read", "packages", [])) as { id: string; name: string; description: string; href: string; permissions: string[]; added: boolean; linked: boolean }[]).filter((p) => p.permissions.includes("provide:llm"));
    // A model that is the browser's own (std/llm/chrome.js) is offered only where the browser has one.
    if (models.some((p) => p.permissions.includes("device-model"))) {
      const has = (await (callService(remote.services, plugin, new Set(["device-model"]), "device-model", "state", [], dispatch as { trace?: string }) as Promise<{ state?: string }>).catch(() => undefined))?.state;
      if (!has || has === "unavailable") models = models.filter((p) => !p.permissions.includes("device-model"));
    }
    if (method === "choices") return models.map(({ id, name, description, added, linked }) => ({ id, name, description, added, linked }));
    const model = models.find((p) => p.id === id);
    if (!model) return { ok: false, error: `${String(id)} isn't a language model this site offers` };
    // The app links it, but it's switched off: switch it on, as the switchboard would.
    if (model.linked) {
      await callService(remote.services, plugin, new Set(["plugins:manage"]), "plugins", "setEnabled", [model.id, true], dispatch as { trace?: string });
      return { ok: true, id: model.id };
    }
    if (!model.added) {
      const added = await as("plugins:author", "add", [model.href, { everywhere: true }]);
      if (!added?.ok) return added;
    }
    const on = await as("plugins:manage", "turn", [model.id, true]);
    return on?.ok === false ? on : { ok: true, id: model.id };
  }

  const service: ServiceProvider = {
    description: "Ask a language model, through whichever provider plugin the app has (std/llm/anthropic.js, std/llm/openai.js, std/llm/gemini.js, or the browser's own with std/llm/chrome.js). The caller never holds a key.",
    methods: {
      providers: { args: "()", returns: "[{ id, name, model?, ready, preferred? }]", needs: "llm", description: "The providers the caller's app has; ready means it has its key, preferred that the person picked it (prefer)." },
      prefer: {
        args: "(provider?)",
        returns: "{ ok, provider? }",
        needs: "llm",
        description: "Sets which of providers() answers a request that names none, for every app the person opens on this device: what a model picker calls. Without one, back to the first that is ready.",
      },
      models: {
        args: "(provider?)",
        returns: "{ models: [{ id, name? }], tiers: { best, balanced, fast }, provider }",
        needs: "llm",
        description: "The models a provider's vendor serves now (the first ready provider's, without one), and the model each tier stands for.",
      },
      choices: {
        args: "()",
        returns: "[{ id, name, description, added, linked }]",
        needs: "llm",
        description: "The language models this site offers (its plugin registry's packages that provide:llm; the browser's built-in one only where the browser has it), for a plugin to offer the person when providers() is empty. added: the person has it here already; linked: the app links it.",
      },
      add: {
        args: "(id)",
        returns: "{ ok, id?, error? }",
        needs: "llm",
        description: "Adds one of choices() to the person's own plugins for every app they open, once they accept a review of its code, and turns it on. It asks for its API key the first time it is asked something.",
      },
      complete: {
        args: "({ messages, system?, tools?, schema?, model?, maxTokens?, provider? })",
        returns: "{ text, json?, toolCalls, stop, usage: { input, output }, provider, model, message }",
        needs: "llm",
        description:
          'Asks a model. messages are { role: "user" | "assistant", content }, an assistant\'s { toolCalls: [{ id, name, args }], state }, or a tool\'s answer { role: "tool", id, name, content }; add each answer\'s message to messages to go on. tools are [{ name, description, parameters }]; schema (the platform\'s JSON Schema subset, as collections use) asks for an answer of that shape, in json, checked before it\'s returned. model is an id or a tier: best, balanced or fast (the default is the provider\'s setting). Without provider, the one the person picked answers (prefer), else the first ready one; when none has its key, each asks for it in turn until the person gives one.',
      },
    },
    capability: () => "llm",
    async call(plugin, method, args, dispatch) {
      if (method === "providers") return providers(dispatch, plugin);
      if (method === "choices" || method === "add") return offered(plugin, dispatch, method, args[0]);
      if (method === "prefer") {
        const id = args[0];
        if (id !== undefined && id !== "" && (typeof id !== "string" || !(await providers(dispatch, plugin)).some((p) => p.id === id))) throw new Error("prefer takes the id of one of llm.providers(), or nothing");
        await store.writeJson(PREFERENCE, id ? { prefer: id } : {});
        return id ? { ok: true, provider: id } : { ok: true };
      }
      const named = method === "models" ? args[0] : (args[0] as LlmRequest | undefined)?.provider;
      if (named !== undefined && typeof named !== "string") throw new Error("provider is a provider's id, from llm.providers()");
      const request = method === "complete" ? checkRequest(args[0]) : undefined;
      const list = await providers(dispatch, plugin);
      // Named, else the one the person picked, else the first with its key. With no key anywhere, each is asked in
      // turn: a provider the person gives no key ("Not now" on its card) answers { declined }, and the next one asks.
      const picked = named !== undefined ? list.find((p) => p.id === named) : (list.find((p) => p.preferred) ?? list.find((p) => p.ready));
      const rest = named === undefined && !picked ? list.slice(1) : [];
      // (A provider that was named and isn't here is an error, never another vendor.)
      let chosen = named !== undefined ? picked : (picked ?? list[0]);
      if (!chosen) throw new Error(named !== undefined ? `No provider ${named} in this app` : "This app has no language model yet. Add one from Customize (Add a plugin), such as Claude (Anthropic), and paste your own API key when it asks");
      if (method === "models") {
        const value = (await root.serial(dispatch, "llm:models", { provider: chosen.id })) as unknown;
        if (!isObject(value)) throw new Error(`${chosen.name} didn't answer`);
        if (typeof value.error === "string") throw new Error(`${chosen.name}: ${value.error.slice(0, 2000)}`);
        const models = Array.isArray(value.models) ? value.models.filter((m): m is Record<string, unknown> => isObject(m) && typeof m.id === "string").map((m) => ({ id: m.id, ...(typeof m.name === "string" ? { name: m.name } : {}) })) : [];
        const tiers = isObject(value.tiers) ? Object.fromEntries(["best", "balanced", "fast"].filter((t) => typeof (value.tiers as Record<string, unknown>)[t] === "string").map((t) => [t, (value.tiers as Record<string, unknown>)[t]])) : {};
        return { models, tiers, provider: chosen.id };
      }
      if (!request) throw new Error(`llm.${method} is not a method`);
      const started = performance.now();
      // Dispatched with serial, which awaits each provider in turn: cordis's bail doesn't wait, so a
      // provider in another worker (whose answer is a promise) would win even when it passes.
      let value = (await root.serial(dispatch, "llm:complete", { ...request, provider: chosen.id })) as unknown;
      while (isObject(value) && value.declined === true && rest.length) {
        chosen = rest.shift()!;
        value = (await root.serial(dispatch, "llm:complete", { ...request, provider: chosen.id })) as unknown;
      }
      const ms = Math.round(performance.now() - started);
      if (!isObject(value)) {
        record({ kind: "error", name: "llm:complete", plugin, detail: `${chosen.id} didn't answer` });
        throw new Error(`${chosen.name} didn't answer`);
      }
      if (typeof value.error === "string") {
        record({ kind: "error", name: "llm:complete", plugin, detail: `${chosen.id}: ${value.error.slice(0, 200)}` });
        throw new Error(`${chosen.name}: ${value.error.slice(0, 2000)}`);
      }
      const answer = cleanAnswer(value, chosen.id);
      // A vendor's structured output is best effort: an answer that isn't of the shape asked for is an error, not a value.
      if (request.schema && answer.stop === "end") {
        const problems = "json" in answer ? validate(request.schema as Schema, answer.json) : [{ path: "", message: "no JSON came back" }];
        if (problems.length) throw new Error(`${chosen.name}'s answer isn't of the shape asked for: ${problems.slice(0, 3).map((p) => `${p.path || "the answer"} ${p.message}`).join("; ")}`);
      }
      const usage = answer.usage as { input: number; output: number };
      record({ kind: "call", name: "llm:complete", plugin, ms, detail: `${chosen.id} ${answer.model} ${answer.stop}, ${usage.input} in, ${usage.output} out` });
      return answer;
    },
  };
  return service;
};

export default service("llm", make);
