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
// (std/llm/module.ts) and Anthropic's Messages API.

export const manifest = {
  id: "llm-anthropic",
  name: "Claude (Anthropic)",
  description: "A language model for this app: Claude, from Anthropic. Uses your own Anthropic API key, which goes only to Anthropic.",
  version: "1.1.0",
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
    } else out.push({ role: m.role, content: m.content });
  }
  return out;
}

const STOP = { end_turn: "end", stop_sequence: "end", tool_use: "tool", max_tokens: "length", refusal: "refused" };

export default function (ctx) {
  const setting = async () => (await ctx.settings.get()).model || manifest.settings.model.default;
  const ready = async () => (await ctx.call("secrets", "has", SECRET)).set;
  const ensureKey = async () => (await ready()) || (await ctx.call("secrets", "request", SECRET, { hosts: [HOST], label: "Anthropic API key" })).set;

  // The live model list, read at most once an hour.
  let listed;

  /**
   * What to say when the vendor answers with an error. A key the vendor refuses is forgotten, so the next
   * request asks for it again: a mis-pasted key would otherwise fail every request with no way to replace it.
   */
  async function failure(response, data) {
    if (response.status === 401) {
      await ctx.call("secrets", "forget", SECRET).catch(() => {});
      listed = undefined;
      return "Anthropic didn't accept that API key, so it has been forgotten. Ask again and paste the key once more.";
    }
    return data.error?.message ?? `HTTP ${response.status}`;
  }
  async function list() {
    if (listed && Date.now() - listed.at < 3_600_000) return listed.models;
    const response = await ctx.call("net", "fetch", { url: `${API}/v1/models?limit=1000`, headers: HEADERS });
    const data = JSON.parse(response.text || "{}");
    if (!response.ok) throw new Error(await failure(response, data));
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
      if (/didn't accept that API key/.test(String(error?.message))) throw error;
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
      if (!(await ensureKey())) return { error: "No Anthropic API key was given" };
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
      if (!(await ensureKey())) return { error: "No Anthropic API key was given" };
      const model = await resolve(request.model ?? (await setting()));
      const body = { model, max_tokens: request.maxTokens ?? 16000, messages: toMessages(request.messages) };
      if (request.system) body.system = request.system;
      if (request.tools?.length) body.tools = request.tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.parameters ?? { type: "object", properties: {} } }));
      if (request.schema) body.output_config = { format: { type: "json_schema", schema: request.schema } };
      const response = await ctx.call("net", "fetch", {
        url: `${API}/v1/messages`,
        method: "POST",
        headers: { ...HEADERS, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = JSON.parse(response.text || "{}");
      if (!response.ok) return { error: await failure(response, data) };
      const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const answer = {
        text,
        toolCalls: data.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input })),
        stop: STOP[data.stop_reason] ?? "end",
        usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
        model: data.model ?? model,
        // Claude's turn as sent, thinking included: a tool call's answer has to go back with it.
        state: data.content,
      };
      if (request.schema && answer.stop === "end") answer.json = JSON.parse(text);
      return answer;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
