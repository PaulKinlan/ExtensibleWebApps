// Gemini, from Google, behind the platform's `llm` service. With this in an
// app, any plugin with the `llm` permission can ask Gemini:
//
//   const answer = await ctx.call("llm", "complete", { messages: [{ role: "user", content: "Hello" }] });
//
// Add it to an app with one line in its app.html:
//
//   <link rel="plugin" href="/std/llm/gemini.js">
//
// The first time a plugin asks, the kernel shows the person a card to paste
// a Gemini API key (aistudio.google.com). The key is kept with the app's
// data, and this plugin never sees it: it names the key in its request
// headers as { secret: "gemini" } and the kernel fills it in, only for
// generativelanguage.googleapis.com (src/kernel/secrets.ts, src/kernel/net.ts).
//
// This file translates between the platform's request and answer
// (src/kernel/services/llm.ts) and the Gemini API's generateContent.

export const manifest = {
  id: "llm-gemini",
  name: "Gemini (Google)",
  description: "Answers the app's llm requests with Gemini, using the person's Gemini API key.",
  version: "1.0.0",
  permissions: ["provide:llm", "network:generativelanguage.googleapis.com", "secret:gemini"],
  settings: {
    model: {
      type: "string",
      title: "Model",
      description: "Which Gemini model answers when a request doesn't name one.",
      default: "gemini-2.5-flash",
    },
  },
};

const API = "https://generativelanguage.googleapis.com";
const HOST = "generativelanguage.googleapis.com";
const SECRET = "gemini";

/** The platform's messages as Gemini's contents: the model's turns are "model", a tool's answer is a functionResponse. */
function toContents(messages) {
  const out = [];
  const push = (role, part) => {
    const last = out[out.length - 1];
    if (last?.role === role) last.parts.push(part);
    else out.push({ role, parts: [part] });
  };
  for (const m of messages) {
    if (m.role === "tool") push("user", { functionResponse: { name: m.name, response: { content: m.content } } });
    else if (m.role === "assistant") {
      if (m.content) push("model", { text: m.content });
      for (const c of m.toolCalls ?? []) push("model", { functionCall: { name: c.name, args: c.args ?? {} } });
    } else push("user", { text: m.content });
  }
  return out;
}

const STOP = { STOP: "end", MAX_TOKENS: "length", SAFETY: "refused", RECITATION: "refused", PROHIBITED_CONTENT: "refused", BLOCKLIST: "refused" };

export default function (ctx) {
  const settings = async () => ({ model: manifest.settings.model.default, ...(await ctx.settings.get()) });
  const ready = async () => (await ctx.call("secrets", "has", SECRET)).set;

  ctx.on("llm:providers", async (value) => {
    const { model } = await settings();
    return { providers: [...value.providers, { id: manifest.id, name: "Gemini", model, ready: await ready() }] };
  });

  ctx.on("llm:complete", async (request) => {
    if (request.provider !== manifest.id) return undefined;
    try {
      if (!(await ready())) {
        const { set } = await ctx.call("secrets", "request", SECRET, { hosts: [HOST], label: "Gemini API key" });
        if (!set) return { error: "No Gemini API key was given" };
      }
      const model = request.model ?? (await settings()).model;
      const body = { contents: toContents(request.messages) };
      if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
      if (request.tools?.length) body.tools = [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description ?? "", parametersJsonSchema: t.parameters ?? { type: "object", properties: {} } })) }];
      const config = {};
      if (request.maxTokens) config.maxOutputTokens = request.maxTokens;
      if (request.schema) Object.assign(config, { responseMimeType: "application/json", responseJsonSchema: request.schema });
      if (Object.keys(config).length) body.generationConfig = config;
      const response = await ctx.call("net", "fetch", {
        url: `${API}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: "POST",
        headers: { "x-goog-api-key": { secret: SECRET }, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = JSON.parse(response.text || "{}");
      if (!response.ok) return { error: data.error?.message ?? `HTTP ${response.status}` };
      const candidate = data.candidates?.[0];
      if (!candidate) return { text: "", stop: "refused", model, usage: { input: data.usageMetadata?.promptTokenCount ?? 0, output: 0 } };
      const parts = candidate.content?.parts ?? [];
      // Gemini's calls may have no id; the answer goes back by name, so any id will do.
      const toolCalls = parts.filter((p) => p.functionCall).map((p, i) => ({ id: p.functionCall.id ?? `call-${i + 1}`, name: p.functionCall.name, args: p.functionCall.args ?? {} }));
      const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
      const answer = {
        text,
        toolCalls,
        stop: toolCalls.length ? "tool" : (STOP[candidate.finishReason] ?? "end"),
        usage: { input: data.usageMetadata?.promptTokenCount ?? 0, output: data.usageMetadata?.candidatesTokenCount ?? 0 },
        model: data.modelVersion ?? model,
      };
      if (request.schema && answer.stop === "end") answer.json = JSON.parse(text);
      return answer;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
