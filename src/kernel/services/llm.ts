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
// Two hooks connect them, both only for plugins with `provide:llm`:
//
// - `llm:providers` (waterfall): each provider adds itself to the list,
//   { id, name, model, ready }, where ready means it has its key.
// - `llm:complete` (bail): the kernel picks a provider and passes the request
//   on with `provider` set to its id; that provider answers, the rest pass.
//   A provider that fails answers { error }, which becomes the caller's error.
//
// The request and answer are the same for every vendor:
//
//   request: { messages, system?, tools?, schema?, model?, maxTokens?, provider? }
//     messages: { role: "user" | "assistant", content }
//             | { role: "assistant", content?, toolCalls: [{ id, name, args }] }
//             | { role: "tool", id, name, content }      (a tool's answer)
//     tools:    [{ name, description, parameters }]     (JSON Schema for the args)
//     schema:   JSON Schema; the answer's `json` then holds a value of that shape
//   answer:  { text, json?, toolCalls, stop, usage: { input, output }, provider, model }
//     stop: "end" | "tool" | "length" | "refused"
//
// Streaming answers come next, with the chat plugin that needs them.

import type { ServiceProvider } from "../remote";
import { defineHook } from "../hooks";
import { record } from "../trace";
import type { Kernel } from "./index";

const MAX = 4_000_000;
const TOOL = /^[a-zA-Z0-9_-]{1,64}$/;

export interface Provider {
  id: string;
  name: string;
  model?: string;
  ready: boolean;
}

export interface LlmRequest {
  messages: { role: "user" | "assistant" | "tool"; content?: string; id?: string; name?: string; toolCalls?: { id: string; name: string; args: unknown }[] }[];
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
      } else if (typeof m.content !== "string") throw new Error(`${where}: an assistant message has content or toolCalls`);
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
  if (request.schema !== undefined && !isObject(request.schema)) throw new Error("schema is a JSON Schema object");
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
  return answer;
}

export default ({ root }: Kernel): ServiceProvider => {
  defineHook("llm:providers", {
    mode: "waterfall",
    timeoutMs: 2000,
    onFailure: "open",
    needs: "provide:llm",
    args: "{ providers: [{ id, name, model?, ready }] }",
    description: "Asks which language models are available. A provider returns { providers: [...providers, itself] }. Listening needs provide:llm.",
  });
  defineHook("llm:complete", {
    mode: "bail",
    // Long enough for a slow model, and for the person to paste a key when the provider asks for one.
    timeoutMs: 11 * 60_000,
    onFailure: "open",
    needs: "provide:llm",
    args: "request, with provider set to the id of the provider that should answer",
    description: "Asks the provider named in request.provider for an answer. Others return nothing. Answer { text, json?, toolCalls?, stop?, usage?, model? }, or { error }. Listening needs provide:llm.",
  });

  async function providers(dispatch: unknown): Promise<Provider[]> {
    const state = { providers: [] as unknown[] };
    await root.waterfall(dispatch, "llm:providers", state, () => state);
    const seen = new Set<string>();
    const out: Provider[] = [];
    for (const p of state.providers) {
      if (!isObject(p) || typeof p.id !== "string" || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, name: typeof p.name === "string" ? p.name : p.id, model: typeof p.model === "string" ? p.model : undefined, ready: p.ready === true });
    }
    return out;
  }

  const service: ServiceProvider = {
    description: "Ask a language model, through whichever provider plugin the app has (std/llm/anthropic.js, std/llm/openai.js, std/llm/gemini.js). The caller never holds a key.",
    methods: {
      providers: { args: "()", returns: "[{ id, name, model?, ready }]", description: "The providers in the app; ready means it has its key. Needs llm." },
      complete: {
        args: "({ messages, system?, tools?, schema?, model?, maxTokens?, provider? })",
        returns: "{ text, json?, toolCalls, stop, usage: { input, output }, provider, model }",
        description:
          'Asks a model. messages are { role: "user" | "assistant", content }, an assistant\'s { toolCalls: [{ id, name, args }] }, or a tool\'s answer { role: "tool", id, name, content }. tools are [{ name, description, parameters }]; schema asks for an answer of that JSON Schema, in json. Without provider, the first ready one answers. Needs llm.',
      },
    },
    capability: () => "llm",
    async call(plugin, method, args, dispatch) {
      if (method === "providers") return providers(dispatch);
      const request = checkRequest(args[0]);
      const list = await providers(dispatch);
      const chosen = request.provider !== undefined ? list.find((p) => p.id === request.provider) : (list.find((p) => p.ready) ?? list[0]);
      if (!chosen) throw new Error(request.provider !== undefined ? `No provider ${request.provider} in this app` : "This app has no language model: link one, such as /std/llm/anthropic.js");
      const started = performance.now();
      // Dispatched with serial, which awaits each provider in turn: cordis's bail doesn't wait, so a
      // provider in another worker (whose answer is a promise) would win even when it passes.
      const value = (await root.serial(dispatch, "llm:complete", { ...request, provider: chosen.id })) as unknown;
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
      const usage = answer.usage as { input: number; output: number };
      record({ kind: "call", name: "llm:complete", plugin, ms, detail: `${chosen.id} ${answer.model} ${answer.stop}, ${usage.input} in, ${usage.output} out` });
      return answer;
    },
  };
  return service;
};
