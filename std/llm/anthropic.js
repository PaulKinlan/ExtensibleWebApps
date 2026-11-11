// Claude, from Anthropic, behind the platform's `llm` service. With this in
// an app, any plugin with the `llm` permission can ask Claude:
//
//   const answer = await ctx.call("llm", "complete", { messages: [{ role: "user", content: "Hello" }] });
//
// Add it to an app with one line in its app.html:
//
//   <link rel="plugin" href="/std/llm/anthropic.js">
//
// The first time a plugin asks, the kernel shows the person a card to paste
// an Anthropic API key (console.anthropic.com). The key is kept with the
// app's data, and this plugin never sees it: it names the key in its request
// headers as { secret: "anthropic" } and the kernel fills it in, only for
// api.anthropic.com (src/kernel/secrets.ts, src/kernel/net.ts).
//
// Models: the `model` setting, or a request's `model`, is a model's id or a
// tier. A tier is the newest Claude of that kind in Anthropic's live model
// list: best is Opus, balanced is Sonnet, fast is Haiku.
//
// This file translates between the platform's request and answer
// (std/llm/module.ts) and Anthropic's Messages API, including streaming SSE
// responses and multimodal user content parts.

export const manifest = {
  id: "llm-anthropic",
  name: "Claude (Anthropic)",
  description: "A language model for this app: Claude, from Anthropic. Uses your own Anthropic API key, which goes only to Anthropic.",
  version: "1.2.0",
  permissions: ["provide:llm", "network:api.anthropic.com", "secret:anthropic"],
  services: ["llm"],
  settings: {
    model: {
      type: "string",
      title: "Model",
      description: "best, balanced or fast for the newest Claude of that kind, or a model's id such as claude-opus-5-5.",
      default: "best",
    },
  },
};

const API = "https://api.anthropic.com";
const HOST = "api.anthropic.com";
const SECRET = "anthropic";

/** Each tier: the model ids it takes, newest by version, and the model to use when the list can't be read. */
const TIERS = {
  best: { pattern: /^claude-opus-(\d+(?:-\d+)?)$/, fallback: "claude-opus-5-5" },
  balanced: { pattern: /^claude-sonnet-(\d+(?:-\d+)?)$/, fallback: "claude-sonnet-5-5" },
  fast: { pattern: /^claude-haiku-(\d+(?:-\d+)?)$/, fallback: "claude-haiku-5-5" },
};

/** Compares versions such as 5-5 and 6, part by part. */
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

const HEADERS = {
  "x-api-key": { secret: SECRET },
  "anthropic-version": "2026-10-21",
  // The request comes from the person's browser, with their own key: Anthropic asks callers to say so.
  "anthropic-dangerous-direct-browser-access": "true",
};

/** User content as Anthropic blocks when multimodal parts are given, or plain text when a string. */
const toUserContent = (content) =>
  Array.isArray(content)
    ? content.map((p) =>
        p.type === "text"
          ? { type: "text", text: p.text }
          : { type: p.type, source: { type: "base64", media_type: p.mediaType, data: p.data } },
      )
    : content;

/** The platform's messages as Anthropic's. A turn with state goes back as Anthropic sent it; tool answers share one user message. */
function toMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.id, content: m.content };
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    } else if (m.role === "assistant" && Array.isArray(m.state)) out.push({ role: "assistant", content: m.state });
    else if (m.role === "assistant" && m.toolCalls?.length) {
      const content = m.content ? [{ type: "text", text: m.content }] : [];
      for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      out.push({ role: "assistant", content });
    } else if (m.role === "user") out.push({ role: "user", content: toUserContent(m.content) });
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

const STOP = { end_turn: "end", stop_sequence: "end", tool_use: "tool", max_tokens: "length", refusal: "refused" };

/** Parses Server-Sent Events into `{ event, data }` items. */
function parseSse(raw) {
  const events = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    let event = "";
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) continue;
    const joined = data.join("\n");
    if (data.length > 1) {
      try {
        JSON.parse(joined);
        events.push({ event, data: joined });
        continue;
      } catch {
        for (const d of data) events.push({ event, data: d });
        continue;
      }
    }
    events.push({ event, data: joined });
  }
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
  const body = { model, max_tokens: request.maxTokens ?? 16000, messages: toMessages(request.messages), ...(stream ? { stream: true } : {}) };
  if (request.system) body.system = request.system;
  if (request.tools?.length) body.tools = request.tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.parameters ?? { type: "object", properties: {} } }));
  if (request.schema) body.output_config = { format: { type: "json_schema", schema: request.schema } };
  return body;
}

function fromJson(data, model, request) {
  const content = data.content ?? [];
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const answer = {
    text,
    toolCalls: content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input })),
    stop: STOP[data.stop_reason] ?? "end",
    usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
    model: data.model ?? model,
    // Claude's turn as sent, thinking included: a tool call's answer has to go back with it.
    state: content,
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
    const { set } = await ctx.call("secrets", "request", SECRET, { hosts: [HOST], label: "Anthropic API key" });
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
      if (used !== given) return "Anthropic didn't accept the earlier API key. Ask again to use the one you gave since.";
      listed = undefined;
      const kept = await ctx.call("secrets", "forget", SECRET).then(() => "", (error) => (error instanceof Error ? error.message : String(error)));
      if (kept) return `Anthropic didn't accept that API key, and it couldn't be forgotten (${kept}). Reset this app's data to give another.`;
      return "Anthropic didn't accept that API key, so it has been forgotten. Ask again and paste the key once more.";
    }
    return data.error?.message ?? `HTTP ${response.status}`;
  }
  async function list() {
    if (listed && Date.now() - listed.at < 3_600_000) return listed.models;
    const used = given;
    const response = await ctx.call("net", "fetch", { url: `${API}/v1/models?limit=1000`, headers: HEADERS });
    const data = JSON.parse(response.text || "{}");
    if (!response.ok) throw new Error(await failure(response, data, used));
    const models = (data.data ?? []).map((m) => ({ id: m.id, name: m.display_name }));
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
    return { providers: [...value.providers, { id: manifest.id, name: "Claude", model: await setting(), ready: await ready() }] };
  });

  ctx.on("llm:models", async ({ provider }) => {
    if (provider !== manifest.id) return undefined;
    try {
      if (!(await ensureKey())) return { error: "No Anthropic API key was given", declined: true };
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
      if (!(await ensureKey())) return { error: "No Anthropic API key was given", declined: true };
      const model = await resolve(request.model ?? (await setting()));
      const used = given;
      const response = await ctx.call("net", "fetch", {
        url: `${API}/v1/messages`,
        method: "POST",
        headers: { ...HEADERS, "content-type": "application/json" },
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
      if (!(await ensureKey())) return { error: "No Anthropic API key was given", declined: true };
      const model = await resolve(request.model ?? (await setting()));
      const used = given;
      const response = await ctx.call("net", "fetch", {
        url: `${API}/v1/messages`,
        method: "POST",
        headers: { ...HEADERS, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(buildBody(request, model, true)),
      });
      const trimmed = (response.text || "").trim();
      if (!response.ok) {
        let data = {};
        try {
          data = trimmed.startsWith("{") ? JSON.parse(trimmed) : JSON.parse(parseSse(trimmed).find((e) => e.event === "error")?.data || "{}");
        } catch {}
        return { error: await failure(response, data, used) };
      }
      if (trimmed.startsWith("{")) {
        const answer = fromJson(JSON.parse(trimmed), model, request);
        if (answer.text) await emitChunks(ctx, request.streamId, [answer.text]);
        return answer;
      }
      const content = [];
      const partialInputs = new Map();
      const deltas = [];
      let stopReason = "end_turn";
      let inputTokens = 0;
      let outputTokens = 0;
      let streamModel = model;
      for (const { event, data: raw } of parseSse(trimmed)) {
        if (!raw || raw === "[DONE]") continue;
        const packet = JSON.parse(raw);
        const type = packet.type || event;
        if (type === "error") return { error: packet.error?.message ?? "Stream error" };
        if (type === "message_start") {
          streamModel = packet.message?.model ?? streamModel;
          inputTokens = packet.message?.usage?.input_tokens ?? inputTokens;
          outputTokens = packet.message?.usage?.output_tokens ?? outputTokens;
        } else if (type === "content_block_start") {
          content[packet.index] = packet.content_block;
          if (packet.content_block?.type === "tool_use") partialInputs.set(packet.index, "");
        } else if (type === "content_block_delta") {
          const block = content[packet.index] ?? (content[packet.index] = { type: "text", text: "" });
          const d = packet.delta ?? {};
          if (d.type === "text_delta" && typeof d.text === "string") {
            block.text = (block.text ?? "") + d.text;
            deltas.push(d.text);
          } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
            partialInputs.set(packet.index, (partialInputs.get(packet.index) ?? "") + d.partial_json);
          } else if (d.type === "thinking_delta" && typeof d.thinking === "string") {
            block.thinking = (block.thinking ?? "") + d.thinking;
          } else if (d.type === "signature_delta" && typeof d.signature === "string") {
            block.signature = (block.signature ?? "") + d.signature;
          }
        } else if (type === "content_block_stop") {
          if (partialInputs.has(packet.index) && content[packet.index]) {
            const jsonText = partialInputs.get(packet.index);
            if (jsonText) content[packet.index].input = JSON.parse(jsonText);
          }
        } else if (type === "message_delta") {
          stopReason = packet.delta?.stop_reason ?? stopReason;
          if (packet.usage?.input_tokens !== undefined) inputTokens = packet.usage.input_tokens;
          if (packet.usage?.output_tokens !== undefined) outputTokens = packet.usage.output_tokens;
        }
      }
      await emitChunks(ctx, request.streamId, deltas);
      return fromJson({ content: content.filter(Boolean), stop_reason: stopReason, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, model: streamModel }, model, request);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
