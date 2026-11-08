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
// (src/kernel/services/llm.ts) and the Responses API.

export const manifest = {
  id: "llm-openai",
  name: "OpenAI",
  description: "Answers the app's llm requests with OpenAI's models, using the person's OpenAI API key.",
  version: "1.1.0",
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

/** The platform's messages as Responses API input items. A turn with state goes back as OpenAI sent it, reasoning included. */
function toInput(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "tool") out.push({ type: "function_call_output", call_id: m.id, output: m.content });
    else if (m.role === "assistant" && Array.isArray(m.state)) out.push(...m.state);
    else if (m.role === "assistant") {
      if (m.content) out.push({ role: "assistant", content: m.content });
      for (const c of m.toolCalls ?? []) out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
    } else out.push({ role: "user", content: m.content });
  }
  return out;
}

export default function (ctx) {
  const setting = async () => (await ctx.settings.get()).model || manifest.settings.model.default;
  const ready = async () => (await ctx.call("secrets", "has", SECRET)).set;
  const ensureKey = async () => (await ready()) || (await ctx.call("secrets", "request", SECRET, { hosts: [HOST], label: "OpenAI API key" })).set;

  // The live model list, read at most once an hour.
  let listed;
  async function list() {
    if (listed && Date.now() - listed.at < 3_600_000) return listed.models;
    const response = await ctx.call("net", "fetch", { url: `${API}/models`, headers: AUTH });
    const data = JSON.parse(response.text || "{}");
    if (!response.ok) throw new Error(data.error?.message ?? `HTTP ${response.status}`);
    const models = (data.data ?? []).map((m) => ({ id: m.id }));
    listed = { at: Date.now(), models };
    return models;
  }
  /** The model a request's model, or the setting, stands for: a tier's newest model, or the id as given. */
  async function resolve(model) {
    const tier = TIERS[model];
    if (!tier) return model;
    const ids = await list().then((models) => models.map((m) => m.id), () => []);
    return newest(ids, tier.pattern) ?? tier.fallback;
  }

  ctx.on("llm:providers", async (value) => {
    return { providers: [...value.providers, { id: manifest.id, name: "OpenAI", model: await setting(), ready: await ready() }] };
  });

  ctx.on("llm:models", async ({ provider }) => {
    if (provider !== manifest.id) return undefined;
    try {
      if (!(await ensureKey())) return { error: "No OpenAI API key was given" };
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
      if (!(await ensureKey())) return { error: "No OpenAI API key was given" };
      const model = await resolve(request.model ?? (await setting()));
      // Nothing is kept on OpenAI's side: each request carries the conversation, with the model's
      // reasoning sent back encrypted so a tool call's answer continues from it.
      const body = { model, input: toInput(request.messages), store: false, include: ["reasoning.encrypted_content"] };
      if (request.system) body.instructions = request.system;
      if (request.maxTokens) body.max_output_tokens = request.maxTokens;
      if (request.tools?.length) body.tools = request.tools.map((t) => ({ type: "function", name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} }, strict: false }));
      if (request.schema) body.text = { format: { type: "json_schema", name: "answer", schema: request.schema, strict: false } };
      const response = await ctx.call("net", "fetch", {
        url: `${API}/responses`,
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = JSON.parse(response.text || "{}");
      if (!response.ok) return { error: data.error?.message ?? `HTTP ${response.status}` };
      const output = data.output ?? [];
      const parts = output.filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
      const text = parts.filter((p) => p.type === "output_text").map((p) => p.text).join("");
      const toolCalls = output.filter((item) => item.type === "function_call").map((c) => ({ id: c.call_id, name: c.name, args: JSON.parse(c.arguments || "{}") }));
      const refused = parts.some((p) => p.type === "refusal");
      const answer = {
        text,
        toolCalls,
        stop: refused ? "refused" : toolCalls.length ? "tool" : data.status === "incomplete" && data.incomplete_details?.reason === "max_output_tokens" ? "length" : "end",
        usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
        model: data.model ?? model,
        state: output,
      };
      if (request.schema && answer.stop === "end") answer.json = JSON.parse(text);
      return answer;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
