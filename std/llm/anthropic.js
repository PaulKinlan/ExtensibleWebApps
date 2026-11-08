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
// This file translates between the platform's request and answer
// (src/kernel/services/llm.ts) and Anthropic's Messages API.

export const manifest = {
  id: "llm-anthropic",
  name: "Claude (Anthropic)",
  description: "Answers the app's llm requests with Claude, using the person's Anthropic API key.",
  version: "1.0.0",
  permissions: ["provide:llm", "network:api.anthropic.com", "secret:anthropic"],
  settings: {
    model: {
      type: "string",
      title: "Model",
      description: "Which Claude answers when a request doesn't name a model.",
      default: "claude-opus-5-5",
      enum: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    },
  },
};

const API = "https://api.anthropic.com";
const HOST = "api.anthropic.com";
const SECRET = "anthropic";

/** The platform's messages as Anthropic's: tool answers go back in a user message, all of a turn's in one. */
function toMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.id, content: m.content };
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const content = m.content ? [{ type: "text", text: m.content }] : [];
      for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      out.push({ role: "assistant", content });
    } else out.push({ role: m.role, content: m.content });
  }
  return out;
}

const STOP = { end_turn: "end", stop_sequence: "end", tool_use: "tool", max_tokens: "length", refusal: "refused" };

export default function (ctx) {
  const settings = async () => ({ model: manifest.settings.model.default, ...(await ctx.settings.get()) });
  const ready = async () => (await ctx.call("secrets", "has", SECRET)).set;

  ctx.on("llm:providers", async (value) => {
    const { model } = await settings();
    return { providers: [...value.providers, { id: manifest.id, name: "Claude", model, ready: await ready() }] };
  });

  ctx.on("llm:complete", async (request) => {
    if (request.provider !== manifest.id) return undefined;
    try {
      if (!(await ready())) {
        const { set } = await ctx.call("secrets", "request", SECRET, { hosts: [HOST], label: "Anthropic API key" });
        if (!set) return { error: "No Anthropic API key was given" };
      }
      const model = request.model ?? (await settings()).model;
      const body = { model, max_tokens: request.maxTokens ?? 16000, messages: toMessages(request.messages) };
      if (request.system) body.system = request.system;
      if (request.tools?.length) body.tools = request.tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.parameters ?? { type: "object", properties: {} } }));
      if (request.schema) body.output_config = { format: { type: "json_schema", schema: request.schema } };
      const response = await ctx.call("net", "fetch", {
        url: `${API}/v1/messages`,
        method: "POST",
        headers: {
          "x-api-key": { secret: SECRET },
          "anthropic-version": "2026-10-21",
          // The request comes from the person's browser, with their own key: Anthropic asks callers to say so.
          "anthropic-dangerous-direct-browser-access": "true",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = JSON.parse(response.text || "{}");
      if (!response.ok) return { error: data.error?.message ?? `HTTP ${response.status}` };
      const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const answer = {
        text,
        toolCalls: data.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input })),
        stop: STOP[data.stop_reason] ?? "end",
        usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
        model: data.model ?? model,
      };
      if (request.schema && answer.stop === "end") answer.json = JSON.parse(text);
      return answer;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
