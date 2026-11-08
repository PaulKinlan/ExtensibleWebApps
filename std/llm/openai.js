// OpenAI's models, or a model running on this computer, behind the
// platform's `llm` service. With this in an app, any plugin with the `llm`
// permission can ask:
//
//   const answer = await ctx.call("llm", "complete", { messages: [{ role: "user", content: "Hello" }] });
//
// Add it to an app with one line in its app.html:
//
//   <link rel="plugin" href="/std/llm/openai.js">
//
// Its `address` setting picks the server:
//
// - OpenAI (the default). The first time a plugin asks, the kernel shows the
//   person a card to paste an OpenAI API key. The key is kept with the app's
//   data and this plugin never sees it: it names the key in its request
//   headers as { secret: "openai" } and the kernel fills it in, only for
//   api.openai.com (src/kernel/secrets.ts, src/kernel/net.ts).
// - Ollama on this computer (http://localhost:11434), with no key. Set
//   `model` to one you have pulled, such as llama3.2.
//
// Many other services speak the same API. To use one, copy this file, give
// the copy its own id, and change ADDRESSES and the network permission to
// that service's host.
//
// This file translates between the platform's request and answer
// (src/kernel/llm.ts) and the Chat Completions API.

export const manifest = {
  id: "llm-openai",
  name: "OpenAI",
  description: "Answers the app's llm requests with OpenAI's models, or with a model served on this computer by Ollama.",
  version: "1.0.0",
  permissions: ["provide:llm", "network:api.openai.com", "network:localhost:11434", "secret:openai"],
  settings: {
    address: {
      type: "string",
      title: "Server",
      description: "OpenAI, or Ollama on this computer.",
      default: "https://api.openai.com/v1",
      enum: ["https://api.openai.com/v1", "http://localhost:11434/v1"],
    },
    model: {
      type: "string",
      title: "Model",
      description: "Which model answers when a request doesn't name one.",
      default: "gpt-5",
    },
  },
};

const ADDRESSES = {
  "https://api.openai.com/v1": { secret: "openai", host: "api.openai.com", label: "OpenAI API key" },
  // A local server has no key.
  "http://localhost:11434/v1": {},
};

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
    } else out.push({ role: m.role, content: m.content });
  }
  return out;
}

const STOP = { stop: "end", tool_calls: "tool", function_call: "tool", length: "length", content_filter: "refused" };

export default function (ctx) {
  const settings = async () => {
    const values = { address: manifest.settings.address.default, model: manifest.settings.model.default, ...(await ctx.settings.get()) };
    return { ...values, server: ADDRESSES[values.address] ?? ADDRESSES[manifest.settings.address.default] };
  };
  const ready = async (server) => !server.secret || (await ctx.call("secrets", "has", server.secret)).set;

  ctx.on("llm:providers", async (value) => {
    const { model, server } = await settings();
    return { providers: [...value.providers, { id: manifest.id, name: server.secret ? "OpenAI" : "Ollama", model, ready: await ready(server) }] };
  });

  ctx.on("llm:complete", async (request) => {
    if (request.provider !== manifest.id) return undefined;
    try {
      const { address, model: chosen, server } = await settings();
      if (!(await ready(server))) {
        const { set } = await ctx.call("secrets", "request", server.secret, { hosts: [server.host], label: server.label });
        if (!set) return { error: `No ${server.label} was given` };
      }
      const model = request.model ?? chosen;
      const body = { model, messages: toMessages(request) };
      if (request.maxTokens) body[server.secret ? "max_completion_tokens" : "max_tokens"] = request.maxTokens;
      if (request.tools?.length) body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } } }));
      if (request.schema) body.response_format = { type: "json_schema", json_schema: { name: "answer", schema: request.schema } };
      const headers = { "content-type": "application/json" };
      if (server.secret) headers.authorization = { secret: server.secret, prefix: "Bearer " };
      const response = await ctx.call("net", "fetch", { url: `${address}/chat/completions`, method: "POST", headers, body: JSON.stringify(body) });
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
