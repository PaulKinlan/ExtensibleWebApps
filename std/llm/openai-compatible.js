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
// (src/kernel/services/llm.ts) and the Chat Completions API.

export const manifest = {
  id: "llm-openai-compatible",
  name: "Ollama",
  description: "Answers the app's llm requests with a model served on this computer by Ollama, or another OpenAI-style API.",
  version: "1.0.0",
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
    } else out.push({ role: m.role, content: m.content ?? "" });
  }
  return out;
}

const STOP = { stop: "end", tool_calls: "tool", function_call: "tool", length: "length", content_filter: "refused" };

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
      if (!(await ensureKey())) return { error: `No ${manifest.name} key was given` };
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
      if (!(await ensureKey())) return { error: `No ${manifest.name} key was given` };
      const model = await resolve(request.model);
      const body = { model, messages: toMessages(request) };
      if (request.maxTokens) body.max_tokens = request.maxTokens;
      if (request.tools?.length) body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } } }));
      if (request.schema) body.response_format = { type: "json_schema", json_schema: { name: "answer", schema: request.schema } };
      const response = await ctx.call("net", "fetch", { url: `${ADDRESS}/chat/completions`, method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = JSON.parse(response.text || "{}");
      if (!response.ok) return { error: data.error?.message ?? `HTTP ${response.status}` };
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
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
