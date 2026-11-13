// OpenAI's models behind the platform's `llm` service. With this in an app,
// any plugin with the `llm` permission can ask GPT:
//
//   const answer = await ctx.call("llm", "complete", { messages: [{ role: "user", content: "Hello" }] });
//
// Add it to an app with one line in its app.html:
//
//   <link rel="plugin" href="/std/llm/openai.js">
//
// The first time a plugin asks, the kernel shows the person a card to paste
// an OpenAI API key. The key is kept with the app's data, and this plugin
// never sees it: it names the key in its request headers as
// { secret: "openai" } and the kernel fills it in, only for api.openai.com
// (src/kernel/secrets.ts, src/kernel/net.ts).
//
// Models: the `model` setting, or a request's `model`, is a model's id or a
// tier. A tier is the newest model of that line in OpenAI's live model list:
// best is Astra, balanced is Sol, fast is Luna.
//
// It speaks the Responses API, which current GPT models need for tool calls.
// For a model on this computer, or another service with an OpenAI-style API,
// use openai-compatible.js.
//
// This file translates between the platform's request and answer
// (std/llm/module.ts) and the Responses API, including streaming SSE responses
// and multimodal user content parts.

export const manifest = {
  id: "llm-openai",
  name: "OpenAI",
  description: "A language model for this app: OpenAI's models. Uses your own OpenAI API key, which goes only to OpenAI.",
  version: "1.2.0",
  permissions: ["provide:llm", "network:api.openai.com", "secret:openai"],
  services: ["llm"],
  settings: {
    model: {
      type: "string",
      title: "Model",
      description: "best, balanced or fast for OpenAI's newest model of that line, or a model's id such as gpt-6-astra.",
      default: "best",
    },
  },
};

const API = "https://api.openai.com/v1";
const HOST = "api.openai.com";
const SECRET = "openai";

/** Each tier: the model ids it takes, newest by version, and the model to use when the list can't be read. */
const TIERS = {
  best: { pattern: /^gpt-(\d+(?:\.\d+)?)-astra$/, fallback: "gpt-6-astra" },
  balanced: { pattern: /^gpt-(\d+(?:\.\d+)?)-sol$/, fallback: "gpt-6.1-sol" },
  fast: { pattern: /^gpt-(\d+(?:\.\d+)?)-luna$/, fallback: "gpt-6-luna" },
};

/** Compares versions such as 6 and 6.1, part by part. */
const compare = (a, b) => {
  const x = a.split(/[-.]/).map(Number);
  const y = b.split(/[-.]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** The id in `ids` with the highest version that `pattern` matches. */
const newest = (ids, pattern) =>
  ids
    .map((id) => [id, pattern.exec(id)?.[1]])
    .filter(([, version]) => version)
    .sort(([, a], [, b]) => compare(b, a))[0]?.[0];

const AUTH = { authorization: { secret: SECRET, prefix: "Bearer " } };

const audioFormat = (mediaType) => {
  const sub = String(mediaType).split("/")[1]?.toLowerCase() ?? "wav";
  return sub === "mpeg" ? "mp3" : sub === "x-wav" ? "wav" : sub;
};

/** User content as Responses API input parts when multimodal, or plain text when a string. */
const toUserContent = (content) =>
  Array.isArray(content)
    ? content.map((p) =>
        p.type === "text"
          ? { type: "input_text", text: p.text }
          : p.type === "image"
            ? { type: "input_image", image_url: `data:${p.mediaType};base64,${p.data}` }
            : { type: "input_audio", input_audio: { data: p.data, format: audioFormat(p.mediaType) } },
      )
    : content;

/** The platform's messages as Responses API input items. A turn with state goes back as OpenAI sent it, reasoning included. */
function toInput(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "tool") out.push({ type: "function_call_output", call_id: m.id, output: m.content });
    else if (m.role === "assistant" && Array.isArray(m.state)) out.push(...m.state);
    else if (m.role === "assistant") {
      if (m.content) out.push({ role: "assistant", content: m.content });
      for (const c of m.toolCalls ?? []) out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
    } else out.push({ role: "user", content: toUserContent(m.content) });
  }
  return out;
}

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
  // Nothing is kept on OpenAI's side: each request carries the conversation, with the model's
  // reasoning sent back encrypted so a tool call's answer continues from it.
  const body = { model, input: toInput(request.messages), store: false, include: ["reasoning.encrypted_content"], ...(stream ? { stream: true } : {}) };
  if (request.system) body.instructions = request.system;
  if (request.maxTokens) body.max_output_tokens = request.maxTokens;
  if (request.tools?.length) body.tools = request.tools.map((t) => ({ type: "function", name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} }, strict: false }));
  if (request.schema) body.text = { format: { type: "json_schema", name: "answer", schema: request.schema, strict: false } };
  return body;
}

function fromJson(data, model, request, fallbackText = "") {
  const output = data.output ?? [];
  const parts = output.filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
  const text = parts.filter((p) => p.type === "output_text").map((p) => p.text).join("") || fallbackText;
  const toolCalls = output.filter((item) => item.type === "function_call").map((c) => ({ id: c.call_id, name: c.name, args: JSON.parse(c.arguments || "{}") }));
  const refused = parts.some((p) => p.type === "refusal");
  const answer = {
    text,
    toolCalls,
    stop: refused ? "refused" : toolCalls.length ? "tool" : data.status === "incomplete" && data.incomplete_details?.reason === "max_output_tokens" ? "length" : "end",
    usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
    model: data.model ?? model,
    state: output.length ? output : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  };
  if (request.schema && answer.stop === "end") answer.json = JSON.parse(text);
  return answer;
}

export default function (ctx) {
  const setting = async () => (await ctx.settings.get()).model || manifest.settings.model.default;
  const ready = async () => (await ctx.call("secrets", "has", SECRET)).set;
  /** Counts the keys the person has given here, so a late answer about an earlier key can't cost them the one they gave since. */
  let given = 0;
  const ensureKey = async () => {
    if (await ready()) return true;
    const { set } = await ctx.call("secrets", "request", SECRET, { hosts: [HOST], label: "OpenAI API key" });
    if (set) given++;
    return set;
  };

  // The live model list, read at most once an hour.
  let listed;

  /**
   * What to say when the vendor answers with an error. A key the vendor refuses is forgotten, so the next
   * request asks for it again: a mis-pasted key would otherwise fail every request with no way to replace it.
   */
  async function failure(response, data, used) {
    if (response.status === 401) {
      // Another request already had this key refused, and the person has given a new one since: leave that one be.
      if (used !== given) return "OpenAI didn't accept the earlier API key. Ask again to use the one you gave since.";
      listed = undefined;
      const kept = await ctx.call("secrets", "forget", SECRET).then(() => "", (error) => (error instanceof Error ? error.message : String(error)));
      if (kept) return `OpenAI didn't accept that API key, and it couldn't be forgotten (${kept}). Reset this app's data to give another.`;
      return "OpenAI didn't accept that API key, so it has been forgotten. Ask again and paste the key once more.";
    }
    return data.error?.message ?? `HTTP ${response.status}`;
  }
  async function list() {
    if (listed && Date.now() - listed.at < 3_600_000) return listed.models;
    const used = given;
    const response = await ctx.call("net", "fetch", { url: `${API}/models`, headers: AUTH });
    const data = JSON.parse(response.text || "{}");
    if (!response.ok) throw new Error(await failure(response, data, used));
    const models = (data.data ?? []).map((m) => ({ id: m.id }));
    listed = { at: Date.now(), models };
    return models;
  }
  /** The model a request's model, or the setting, stands for: a tier's newest model, or the id as given. */
  async function resolve(model) {
    const tier = TIERS[model];
    if (!tier) return model;
    // A list that can't be read falls back to the tier's own model, but a refused key ends the request here.
    const ids = await list().then((models) => models.map((m) => m.id), (error) => {
      if (/didn't accept (that|the earlier) API key/.test(String(error?.message))) throw error;
      return [];
    });
    return newest(ids, tier.pattern) ?? tier.fallback;
  }

  ctx.on("llm:providers", async (value) => {
    return { providers: [...value.providers, { id: manifest.id, name: "OpenAI", model: await setting(), ready: await ready() }] };
  });

  ctx.on("llm:models", async ({ provider }) => {
    if (provider !== manifest.id) return undefined;
    try {
      if (!(await ensureKey())) return { error: "No OpenAI API key was given", declined: true };
      const models = await list();
      const ids = models.map((m) => m.id);
      return { models, tiers: Object.fromEntries(Object.entries(TIERS).map(([name, t]) => [name, newest(ids, t.pattern) ?? t.fallback])) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ctx.on("llm:complete", async (request) => {
    if (request.provider !== manifest.id) return undefined;
    try {
      if (!(await ensureKey())) return { error: "No OpenAI API key was given", declined: true };
      const model = await resolve(request.model ?? (await setting()));
      const used = given;
      const response = await ctx.call("net", "fetch", {
        url: `${API}/responses`,
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify(buildBody(request, model, false)),
      });
      const data = JSON.parse(response.text || "{}");
      if (!response.ok) return { error: await failure(response, data, used) };
      return fromJson(data, model, request);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ctx.on("llm:stream", async (request) => {
    if (request.provider !== manifest.id) return undefined;
    try {
      if (!(await ensureKey())) return { error: "No OpenAI API key was given", declined: true };
      const model = await resolve(request.model ?? (await setting()));
      const used = given;
      const fetchStreamId = crypto.randomUUID();
      const deltas = [];
      const items = [];
      let completed;
      let refused = false;
      let streamError = "";
      let parseFailure = null;
      let sending = Promise.resolve();
      let batch = [];
      const parser = makeSseParser(({ event, data: raw }) => {
        if (streamError || !raw || raw === "[DONE]") return;
        const packet = JSON.parse(raw);
        const type = packet.type || event;
        if (type === "error" || type === "response.failed") {
          streamError = packet.error?.message ?? packet.response?.error?.message ?? "Stream error";
          return;
        }
        if (type === "response.output_text.delta" && typeof packet.delta === "string") {
          deltas.push(packet.delta);
          if (packet.delta.length) batch.push(packet.delta);
        } else if (type === "response.refusal.delta") refused = true;
        else if (type === "response.output_item.done" && packet.item) items.push(packet.item);
        else if ((type === "response.completed" || type === "response.incomplete" || type === "response.done") && packet.response) completed = packet.response;
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
          url: `${API}/responses`,
          method: "POST",
          headers: { ...AUTH, "content-type": "application/json", accept: "text/event-stream" },
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
          data = trimmed.startsWith("{") ? JSON.parse(trimmed) : JSON.parse(parseSse(trimmed).find((e) => e.event === "error")?.data || "{}");
        } catch {}
        return { error: await failure(response, data, used) };
      }
      if (parseFailure) throw parseFailure;
      if (streamError) return { error: streamError };
      if (parser.isJsonFallback || (!deltas.length && !completed && trimmed.startsWith("{"))) {
        const answer = fromJson(JSON.parse(trimmed), model, request);
        if (answer.text) await emitChunks(ctx, request.streamId, [answer.text]);
        return answer;
      }
      const streamedText = deltas.join("");
      if (completed) return fromJson(completed, model, request, streamedText);
      const fallbackOutput = items.length ? items : refused ? [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: streamedText }] }] : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: streamedText }] }];
      return fromJson({ model, status: "completed", output: fallbackOutput }, model, request, streamedText);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
