// The `llm` service: one way for any plugin to ask a language model, whoever
// makes the model. The platform fixes the interface; vendor and on-device
// plugins plug in behind it (std/llm/anthropic.js, std/llm/openai.js,
// std/llm/gemini.js, std/llm/openai-compatible.js, std/llm/chrome.js, std/llm/space.js).
//
//   const answer = await ctx.call("llm", "complete", {
//     system: "You answer in one sentence.",
//     messages: [{ role: "user", content: "What is a kernel?" }],
//   });
//   answer.text   // "A kernel is ..."
//
// For live token updates, call `llm.stream` and listen to `llm:chunk`:
//
//   ctx.on("llm:chunk", ({ streamId, delta, done }) => { ... });
//   const answer = await ctx.call("llm", "stream", { streamId: "q1", messages });
//
// A plugin that calls it needs the `llm` permission, and nothing else: it
// never sees a key, and never learns which vendor's API was reached. A vendor
// plugin needs `provide:llm`, the `network:<host>` of its API and the
// `secret:<name>` of its key, which the kernel fills into its requests
// (secrets.ts, net.ts).
//
// Hooks connect them:
//
// - `llm:providers` (waterfall): each provider adds itself to the list,
//   { id, name, model, ready }, where ready means it can answer right now.
// - `llm:complete`: the kernel picks a provider and passes the request on
//   with `provider` set to its id; that provider answers, the rest pass.
//   A provider that fails answers { error }, which becomes the caller's error.
// - `llm:stream`: like `llm:complete`, with `streamId` set; the provider sends
//   deltas via `llm.chunk(streamId, delta)`. If a provider doesn't implement
//   `llm:stream` (returns undefined), `llm.stream` falls back to `llm:complete`
//   and emits the text as chunks followed by `{ streamId, delta: "", done: true }`.
// - `llm:chunk` (emit, needs `llm`): `{ streamId, delta, done }` pieces of a
//   streaming answer.
// - `llm:models`: the provider named in `provider` lists the models its
//   vendor serves now, and which one each tier stands for.
//
// The request and answer are the same for every vendor:
//
//   request: { messages, system?, tools?, schema?, model?, maxTokens?, provider?, streamId? }
//     messages: { role: "user", content: string | Part[] }
//             | { role: "assistant", content? }
//             | { role: "assistant", content?, toolCalls: [{ id, name, args }], state? }
//             | { role: "tool", id, name, content }      (a tool's answer)
//     Part:     { type: "text", text }
//             | { type: "image", mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif", data }
//             | { type: "audio", mediaType, data }
//     tools:    [{ name, description, parameters }]     (JSON Schema for the args)
//     schema:   JSON Schema; the answer's `json` then holds a value of that shape
//     model:    a model's id, or a tier: "best", "balanced" or "fast". A tier
//               is the provider's newest model of that kind, looked up live, so
//               an app keeps up with new models without changing its code.
//   answer:  { text, json?, toolCalls, stop, usage: { input, output }, provider, model, message, streamId? }
//     stop:    "end" | "tool" | "length" | "refused"
//     message: the model's turn, ready to add to `messages` for the next request.
//              Its `state` is the vendor's own record of the turn (such as the
//              model's reasoning before a tool call), which some vendors need
//              back; pass it on unchanged.

import { env } from "../../src/kernel/env";
import { callService, type ServiceProvider } from "../../src/kernel/remote";
import { record } from "../../src/kernel/trace";
import { checkSchema, validate, type Schema } from "../../src/kernel/schema";
import { service, type ModuleKernel } from "../../src/kernel/modules";

const MAX = 4_000_000;
const TOOL = /^[a-zA-Z0-9_-]{1,64}$/;
const IMAGE_MEDIA = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const AUDIO_MEDIA = /^audio\/[a-z0-9.+-]+$/i;
const DATA_URL = /^data:([^;,\s]+);base64,([\s\S]*)$/i;

export type LlmImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: LlmImageMediaType; data: string }
  | { type: "audio"; mediaType: string; data: string };

export interface Provider {
  id: string;
  name: string;
  model?: string;
  ready: boolean;
  /** The one the person picked to answer when a request names none (llm.prefer). */
  preferred?: boolean;
}

export interface LlmRequest {
  messages: { role: "user" | "assistant" | "tool"; content?: string | LlmContentPart[]; id?: string; name?: string; toolCalls?: { id: string; name: string; args: unknown }[]; state?: unknown }[];
  system?: string;
  tools?: { name: string; description?: string; parameters?: unknown }[];
  schema?: unknown;
  model?: string;
  maxTokens?: number;
  provider?: string;
  streamId?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Checks and normalizes one multimodal part of a user message, stripping any `data:...;base64,` prefix. */
function checkUserPart(part: unknown, where: string): LlmContentPart {
  if (!isObject(part)) throw new Error(`${where} isn't a content part`);
  if (part.type === "text") {
    if (typeof part.text !== "string") throw new Error(`${where}: a text part needs text`);
    return { type: "text", text: part.text };
  }
  if (part.type === "image") {
    if (typeof part.data !== "string") throw new Error(`${where}: an image part needs base64 data`);
    const match = DATA_URL.exec(part.data.trim());
    const data = (match ? match[2] : part.data).replace(/\s+/g, "");
    const mediaType = typeof part.mediaType === "string" ? part.mediaType.toLowerCase() : match?.[1]?.toLowerCase();
    if (!mediaType || !IMAGE_MEDIA.has(mediaType)) throw new Error(`${where}: image mediaType must be image/png, image/jpeg, image/webp or image/gif`);
    if (!data) throw new Error(`${where}: image data is empty`);
    return { type: "image", mediaType: mediaType as LlmImageMediaType, data };
  }
  if (part.type === "audio") {
    if (typeof part.data !== "string") throw new Error(`${where}: an audio part needs base64 data`);
    const match = DATA_URL.exec(part.data.trim());
    const data = (match ? match[2] : part.data).replace(/\s+/g, "");
    const mediaType = typeof part.mediaType === "string" ? part.mediaType.toLowerCase() : match?.[1]?.toLowerCase();
    if (!mediaType || !AUDIO_MEDIA.test(mediaType)) throw new Error(`${where}: audio mediaType must be an audio/* MIME type`);
    if (!data) throw new Error(`${where}: audio data is empty`);
    return { type: "audio", mediaType, data };
  }
  throw new Error(`${where}: part type must be text, image or audio`);
}

/** Splits non-streamed fallback text into bounded chunks whose concatenation equals `text`. */
function fallbackChunks(text: string): string[] {
  if (!text) return [];
  const words = text.match(/\S+\s*|\s+/g) ?? [text];
  if (words.length <= 32) return words;
  const step = Math.ceil(words.length / 32);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += step) out.push(words.slice(i, i + step).join(""));
  return out;
}

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
      if (Array.isArray(m.content)) {
        if (!m.content.length) throw new Error(`${where}: content parts can't be empty`);
        m.content = m.content.map((p, j) => checkUserPart(p, `${where}.content[${j}]`));
      } else if (typeof m.content !== "string") {
        throw new Error(`${where}: a user message's content is text or a non-empty list of parts`);
      }
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
  if (request.streamId !== undefined && (typeof request.streamId !== "string" || !request.streamId.length || request.streamId.length > 128)) throw new Error("streamId is text up to 128 characters");
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
  /** Streams currently under way, keyed by `${caller}:${streamId}`, so tabs cannot collide and only the answering provider can emit chunks. */
  const activeStreams = new Map<string, { caller: string; streamId: string; provider: string; emitted: boolean }>();
  root.on("internal/stopped", (instance: string) => {
    for (const [key, entry] of activeStreams) if (entry.caller === instance) activeStreams.delete(key);
  });

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
  kernel.hook("llm:stream", {
    mode: "bail",
    timeoutMs: 11 * 60_000,
    onFailure: "open",
    needs: "provide:llm",
    args: "request, with provider set to the id of the provider that should answer, and streamId",
    description: "Asks the provider named in request.provider to stream an answer, sending text deltas through llm.chunk(streamId, delta). Others return nothing; returning nothing falls back to llm:complete. Answer { text, json?, toolCalls?, stop?, usage?, model?, state? }, or { error }, with declined: true when the person gave it no key. Listening needs provide:llm.",
  });
  kernel.hook("llm:chunk", {
    mode: "emit",
    needs: "llm",
    quiet: true,
    args: "{ streamId, delta, done }",
    description: "A piece of a streaming answer from llm.stream, with streamId matching the request's, delta text, and done: true once the stream ends. Listening needs llm.",
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
      out.push({ id: p.id, name: typeof p.name === "string" ? p.name : p.id, ready: p.ready === true, ...(typeof p.model === "string" ? { model: p.model } : {}) });
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
      const has = (await (callService(remote.services, plugin, new Set(), "device-model", "state", [], dispatch as { trace?: string }) as Promise<{ state?: string }>).catch(() => undefined))?.state;
      if (!has || has === "unavailable") models = models.filter((p) => !p.permissions.includes("device-model"));
    }
    // And the model a space holds a key for (std/llm/space.js) only in a space whose owner has given it one.
    if (models.some((p) => p.permissions.includes("space-model"))) {
      const has = env().space ? ((await (callService(remote.services, plugin, new Set(), "sync", "model", [], dispatch as { trace?: string }) as Promise<{ set?: boolean }>).catch(() => undefined))?.set ?? false) : false;
      if (!has) models = models.filter((p) => !p.permissions.includes("space-model"));
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
    description: "Ask a language model, through whichever provider plugin the app has (std/llm/anthropic.js, std/llm/openai.js, std/llm/gemini.js, the browser's own with std/llm/chrome.js, or a space's with std/llm/space.js). The caller never holds a key.",
    methods: {
      providers: { args: "()", returns: "[{ id, name, model?, ready, preferred? }]", needs: "llm", description: "The providers the caller's app has; ready means it can answer right now, preferred that the person picked it (prefer)." },
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
          'Asks a model. messages are { role: "user" | "assistant", content } (where a user message\'s content is text or a list of text, image and audio parts), an assistant\'s { toolCalls: [{ id, name, args }], state }, or a tool\'s answer { role: "tool", id, name, content }; add each answer\'s message to messages to go on. tools are [{ name, description, parameters }]; schema (the platform\'s JSON Schema subset, as collections use) asks for an answer of that shape, in json, checked before it\'s returned. model is an id or a tier: best, balanced or fast (the default is the provider\'s setting). Without provider, the one the person picked answers (prefer), else the first ready one; when none has its key, each asks for it in turn until the person gives one.',
      },
      stream: {
        args: "({ messages, system?, tools?, schema?, model?, maxTokens?, provider?, streamId? })",
        returns: "{ text, json?, toolCalls, stop, usage: { input, output }, provider, model, message, streamId }",
        needs: "llm",
        description:
          "Streams an answer from a model. Takes the same request as complete with an optional streamId, emits { streamId, delta, done } on llm:chunk as text arrives (falling back to llm:complete when a provider doesn't implement llm:stream), and resolves to complete's answer with streamId.",
      },
      chunk: {
        args: "(streamId, delta)",
        returns: "true",
        needs: "provide:llm",
        quiet: true,
        description: "For a provider answering llm:stream: emits a text delta on llm:chunk for streamId.",
      },
    },
    capability: (method) => (method === "chunk" ? "provide:llm" : "llm"),
    async call(plugin, method, args, dispatch) {
      if (method === "chunk") {
        const [id, delta] = args;
        if (typeof id !== "string" || typeof delta !== "string") throw new Error("llm.chunk takes (streamId, delta)");
        const providerId = plugin.split("@")[0];
        let active = activeStreams.get(id);
        if (!active) {
          const matches = [...activeStreams.values()].filter((s) => s.streamId === id && s.provider === providerId);
          if (matches.length === 1) active = matches[0];
        }
        if (!active || active.provider !== providerId) return false;
        if (delta.length) {
          active.emitted = true;
          remote.emitTo(active.caller, "llm:chunk", { streamId: active.streamId, delta, done: false }, dispatch.trace);
        }
        return true;
      }
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
      const streaming = method === "stream";
      const parsed = method === "complete" || streaming ? checkRequest(args[0]) : undefined;
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
      if (!parsed) throw new Error(`llm.${method} is not a method`);
      const { streamId: requestedStreamId, ...request } = parsed;
      const streamId = streaming ? (requestedStreamId ?? crypto.randomUUID()) : undefined;
      const streamKey = streamId ? `${plugin}:${streamId}` : undefined;
      if (streamKey && activeStreams.has(streamKey)) throw new Error(`Stream ${streamId} is already active`);
      const traceName = streaming ? "llm:stream" : "llm:complete";
      const started = performance.now();

      const askOne = async (providerId: string): Promise<unknown> => {
        if (!streaming) return root.serial(dispatch, "llm:complete", { ...request, provider: providerId });
        activeStreams.set(streamKey!, { caller: plugin, streamId: streamId!, provider: providerId, emitted: false });
        const streamed = await root.serial(dispatch, "llm:stream", { ...request, provider: providerId, streamId: streamKey });
        if (streamed !== undefined) return streamed;
        // Provider doesn't implement llm:stream: fall back to llm:complete.
        return root.serial(dispatch, "llm:complete", { ...request, provider: providerId });
      };

      let value: unknown;
      try {
        // Dispatched with serial, which awaits each provider in turn: cordis's bail doesn't wait, so a
        // provider in another worker (whose answer is a promise) would win even when it passes.
        value = await askOne(chosen.id);
        while (isObject(value) && value.declined === true && rest.length) {
          chosen = rest.shift()!;
          value = await askOne(chosen.id);
        }
        const ms = Math.round(performance.now() - started);
        if (!isObject(value)) {
          record({ kind: "error", name: traceName, plugin, detail: `${chosen.id} didn't answer` });
          throw new Error(`${chosen.name} didn't answer`);
        }
        if (typeof value.error === "string") {
          record({ kind: "error", name: traceName, plugin, detail: `${chosen.id}: ${value.error.slice(0, 200)}` });
          throw new Error(`${chosen.name}: ${value.error.slice(0, 2000)}`);
        }
        const answer = cleanAnswer(value, chosen.id);
        // A vendor's structured output is best effort: an answer that isn't of the shape asked for is an error, not a value.
        if (request.schema && answer.stop === "end") {
          const problems = "json" in answer ? validate(request.schema as Schema, answer.json) : [{ path: "", message: "no JSON came back" }];
          if (problems.length) throw new Error(`${chosen.name}'s answer isn't of the shape asked for: ${problems.slice(0, 3).map((p) => `${p.path || "the answer"} ${p.message}`).join("; ")}`);
        }
        if (streaming && streamId && streamKey) {
          const state = activeStreams.get(streamKey);
          if (!state?.emitted) {
            const chunks = Array.isArray(value.chunks) ? value.chunks.filter((c): c is string => typeof c === "string" && c.length > 0) : fallbackChunks(answer.text as string);
            for (const delta of chunks) remote.emitTo(plugin, "llm:chunk", { streamId, delta, done: false }, dispatch.trace);
          }
          remote.emitTo(plugin, "llm:chunk", { streamId, delta: "", done: true }, dispatch.trace);
          answer.streamId = streamId;
        }
        const usage = answer.usage as { input: number; output: number };
        record({ kind: "call", name: traceName, plugin, ms, detail: `${chosen.id} ${answer.model} ${answer.stop}, ${usage.input} in, ${usage.output} out` });
        return answer;
      } finally {
        if (streamKey) activeStreams.delete(streamKey);
      }
    },
  };
  return service;
};

export default service("llm", make);
