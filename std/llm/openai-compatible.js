// A model served with an OpenAI-style Chat Completions API, behind the
// platform's `llm` service. As written it reaches Ollama on this computer
// (http://localhost:11434), which needs no key:
//
//   <link rel="plugin" href="/std/llm/openai-compatible.js">
//
// Set its `model` setting to a model you have pulled, such as llama3.2, or
// leave it empty for the first one Ollama lists. Ollama only answers pages
// from other sites when OLLAMA_ORIGINS includes this site's address.
//
// Many services speak this API (LM Studio, vLLM, OpenRouter, Groq and more).
// To use one, copy this file, give the copy its own id, and change ADDRESS,
// HOST and the network permission to that service's; for one that needs a
// key, add `secret:<name>` to the permissions and set SECRET to that name.
// For OpenAI itself, use openai.js.
//
// This file translates between the platform's request and answer
// (std/llm/module.ts) and the Chat Completions API, including streaming SSE
// responses and multimodal user content parts.

export const manifest = {
  id: "llm-openai-compatible",
  name: "Ollama",
  description: "A language model for this app that runs on your own computer, with Ollama. No key needed.",
  version: "1.1.0",
  permissions: ["provide:llm", "network:localhost:11434"],
  services: ["llm"],
  settings: {
    model: {
      type: "string",
      title: "Model",
      description: "The model's name, such as llama3.2. Empty for the first one the server lists.",
      default: "",
    },
  },
};

const ADDRESS = "http://localhost:11434/v1";
const HOST = "localhost:11434";
/** The name of the key this service needs, or "" for none. */
const SECRET = "";

const audioFormat = (mediaType) => {
  const sub = String(mediaType).split("/")[1]?.toLowerCase() ?? "wav";
  return sub === "mpeg" ? "mp3" : sub === "x-wav" ? "wav" : sub;
};

/** User content as Chat Completions parts when multimodal, or plain text when a string. */
const toUserContent = (content) =>
  Array.isArray(content)
    ? content.map((p) =>
        p.type === "text"
          ? { type: "text", text: p.text }
          : p.type === "image"
            ? { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } }
            : { type: "input_audio", input_audio: { data: p.data, format: audioFormat(p.mediaType) } },
      )
    : (content ?? "");

/** The platform's messages as Chat Completions messages. */
function toMessages(request) {
  const out = request.system ? [{ role: "system", content: request.system }] : [];
  for (const m of request.messages) {
    if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.id, content: m.content });
    else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content ?? null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
      });
    } else if (m.role === "user") out.push({ role: "user", content: toUserContent(m.content) });
    else out.push({ role: m.role, content: m.content ?? "" });
  }
  return out;
}

const STOP = { stop: "end", tool_calls: "tool", function_call: "tool", length: "length", content_filter: "refused" };

/** Incremental Server-Sent Events parser for streaming net:chunk deliveries. */
function makeSseParser(onEvent) {
  let buffer = "";
  let jsonFallback = false;
  const parseBlock = (block) => {
    let event = "";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return;
    const joined = data.join("\n");
    if (data.length > 1) {
      try {
        JSON.parse(joined);
        onEvent({ event, data: joined });
        return;
      } catch {
        for (const d of data) onEvent({ event, data: d });
        return;
      }
    }
    onEvent({ event, data: joined });
  };
  return {
    push(chunk, done = false) {
      if (chunk) buffer += chunk;
      const heldCr = !done && buffer.endsWith("\r") ? "\r" : "";
      let ready = (heldCr ? buffer.slice(0, -1) : buffer).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (jsonFallback) {
        buffer = ready + heldCr;
        return;
      }
      const trimmedStart = ready.trimStart();
      if (trimmedStart.startsWith("{") || trimmedStart.startsWith("[")) {
        jsonFallback = true;
        buffer = ready + heldCr;
        return;
      }
      let sep;
      while ((sep = ready.indexOf("\n\n")) !== -1) {
        const block = ready.slice(0, sep);
        ready = ready.slice(sep + 2);
        parseBlock(block);
      }
      if (done && ready.trim()) parseBlock(ready);
      buffer = done ? "" : ready + heldCr;
    },
    get isJsonFallback() {
      return jsonFallback;
    },
  };
}

/** Parses Server-Sent Events into `{ event, data }` items. */
function parseSse(raw) {
  const events = [];
  makeSseParser((e) => events.push(e)).push(raw, true);
  return events;
}

/** Sends deltas through llm.chunk, coalescing very long buffered streams so worker message rates stay bounded. */
const CHUNK = "chunk";
async function emitChunks(ctx, streamId, deltas) {
  if (!streamId || !deltas.length) return;
  const step = deltas.length <= 64 ? 1 : Math.ceil(deltas.length / 64);
  for (let i = 0; i < deltas.length; i += step) {
    const delta = step === 1 ? deltas[i] : deltas.slice(i, i + step).join("");
    if (delta) await ctx.call("llm", CHUNK, streamId, delta);
  }
}

function buildBody(request, model, stream = false) {
  const body = { model, messages: toMessages(request), ...(stream ? { stream: true } : {}) };
  if (request.maxTokens) body.max_tokens = request.maxTokens;
  if (request.tools?.length) body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } } }));
  if (request.schema) body.response_format = { type: "json_schema", json_schema: { name: "answer", schema: request.schema } };
  return body;
}

function fromJson(data, model, request) {
  const choice = data.choices?.[0] ?? {};
  const text = choice.message?.content ?? "";
  const answer = {
    text,
    toolCalls: (choice.message?.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments || "{}") })),
    stop: choice.message?.refusal ? "refused" : (STOP[choice.finish_reason] ?? "end"),
    usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
    model: data.model ?? model,
  };
  if (request.schema && answer.stop === "end") answer.json = JSON.parse(text);
  return answer;
}

export default function (ctx) {
  const headers = SECRET ? { authorization: { secret: SECRET, prefix: "Bearer " } } : {};
  const ready = async () => !SECRET || (await ctx.call("secrets", "has", SECRET)).set;
  const ensureKey = async () => (await ready()) || (await ctx.call("secrets", "request", SECRET, { hosts: [HOST], label: `${manifest.name} key` })).set;
  async function list() {
    const response = await ctx.call("net", "fetch", { url: `${ADDRESS}/models`, headers });
    const data = JSON.parse(response.text || "{}");
    if (!response.ok) throw new Error(data.error?.message ?? `HTTP ${response.status}`);
    return (data.data ?? []).map((m) => ({ id: m.id }));
  }
  /** The setting's model, or for a tier or no setting, the first the server lists: it has no tiers of its own. */
  async function resolve(model) {
    if (model && !["best", "balanced", "fast"].includes(model)) return model;
    const setting = (await ctx.settings.get()).model;
    if (setting) return setting;
    const [first] = await list();
    if (!first) throw new Error(`${manifest.name} has no models: pull one first`);
    return first.id;
  }

  ctx.on("llm:providers", async (value) => {
    return { providers: [...value.providers, { id: manifest.id, name: manifest.name, model: (await ctx.settings.get()).model || undefined, ready: await ready() }] };
  });

  ctx.on("llm:models", async ({ provider }) => {
    if (provider !== manifest.id) return undefined;
    try {
      if (!(await ensureKey())) return { error: `No ${manifest.name} key was given`, declined: true };
      const models = await list();
      const model = await resolve();
      return { models, tiers: { best: model, balanced: model, fast: model } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ctx.on("llm:complete", async (request) => {
    if (request.provider !== manifest.id) return undefined;
    try {
      if (!(await ensureKey())) return { error: `No ${manifest.name} key was given`, declined: true };
      const model = await resolve(request.model);
      const response = await ctx.call("net", "fetch", { url: `${ADDRESS}/chat/completions`, method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(buildBody(request, model, false)) });
      const data = JSON.parse(response.text || "{}");
      if (!response.ok) return { error: data.error?.message ?? `HTTP ${response.status}` };
      return fromJson(data, model, request);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ctx.on("llm:stream", async (request) => {
    if (request.provider !== manifest.id) return undefined;
    try {
      if (!(await ensureKey())) return { error: `No ${manifest.name} key was given`, declined: true };
      const model = await resolve(request.model);
      const fetchStreamId = crypto.randomUUID();
      const deltas = [];
      const callsByIndex = new Map();
      let finishReason;
      let refused = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let resolvedModel = model;
      let streamError = "";
      let parseFailure = null;
      let sawEvents = false;
      let sending = Promise.resolve();
      let batch = [];
      const parser = makeSseParser(({ data: raw }) => {
        if (streamError || !raw || raw === "[DONE]") return;
        sawEvents = true;
        const packet = JSON.parse(raw);
        if (packet.error) {
          streamError = packet.error.message ?? "Stream error";
          return;
        }
        if (packet.model) resolvedModel = packet.model;
        if (packet.usage) {
          inputTokens = packet.usage.prompt_tokens ?? inputTokens;
          outputTokens = packet.usage.completion_tokens ?? outputTokens;
        }
        const choice = packet.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length) {
          deltas.push(delta.content);
          batch.push(delta.content);
        }
        if (delta.refusal) refused = true;
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const entry = callsByIndex.get(idx) ?? { id: tc.id ?? `call-${idx + 1}`, name: "", args: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          callsByIndex.set(idx, entry);
        }
      });
      const off = ctx.on("net:chunk", ({ streamId, chunk, done }) => {
        if (streamId !== fetchStreamId || parseFailure || streamError) return;
        batch = [];
        try {
          parser.push(chunk, Boolean(done));
        } catch (err) {
          parseFailure = err;
          return;
        }
        if (batch.length && !streamError) {
          const out = batch;
          sending = sending.then(() => emitChunks(ctx, request.streamId, out));
        }
      });
      let response;
      try {
        response = await ctx.call("net", "fetch", {
          url: `${ADDRESS}/chat/completions`,
          method: "POST",
          headers: { ...headers, "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify(buildBody(request, model, true)),
          streamId: fetchStreamId,
        });
      } finally {
        off();
      }
      await sending;
      const trimmed = (response.text || "").trim();
      if (!response.ok) {
        let data = {};
        try {
          data = trimmed.startsWith("{") ? JSON.parse(trimmed) : JSON.parse(parseSse(trimmed)[0]?.data || "{}");
        } catch {}
        return { error: data.error?.message ?? `HTTP ${response.status}` };
      }
      if (parseFailure) throw parseFailure;
      if (streamError) return { error: streamError };
      if (parser.isJsonFallback || (!sawEvents && trimmed.startsWith("{"))) {
        const answer = fromJson(JSON.parse(trimmed), model, request);
        if (answer.text) await emitChunks(ctx, request.streamId, [answer.text]);
        return answer;
      }
      const text = deltas.join("");
      const toolCalls = [...callsByIndex.entries()].sort(([a], [b]) => a - b).map(([, c]) => ({ id: c.id, name: c.name, args: JSON.parse(c.args || "{}") }));
      const answer = {
        text,
        toolCalls,
        stop: refused ? "refused" : toolCalls.length ? "tool" : (STOP[finishReason] ?? "end"),
        usage: { input: inputTokens, output: outputTokens },
        model: resolvedModel,
      };
      if (request.schema && answer.stop === "end") answer.json = JSON.parse(text);
      return answer;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
