// Chrome's built-in model, behind the platform's `llm` service: a language
// model that needs no key. It runs on the person's own computer, so asking it
// costs nothing and nothing they ask leaves the device.
//
//   <link rel="plugin" href="/std/llm/chrome.js">
//
// It is a model only where the browser has one: a recent Chrome on a computer
// with enough memory and disk space (not a phone). Anywhere else this plugin
// lists no model, and the site doesn't offer it (llm.choices). The first time
// it is asked, Chrome may have to download the model (several GB, once for
// the whole browser); the answer then says so and how far it has got.
//
// It is a small model. It answers questions about a page well enough; it
// reads a few thousand words at once, and is weaker than the vendors' models
// at writing code. It has no tool calls of its own, so when a request has
// tools this file asks for an answer of a fixed shape (which tool, with which
// arguments, or the answer) and reads the tool call out of it.
//
// The browser's API is in pages, not workers, so this file asks through the
// `device-model` service (std/device-model/module.ts), which asks a tab.
// This file translates between the platform's request and answer
// (std/llm/module.ts) and that service.

export const manifest = {
  id: "llm-chrome",
  name: "Chrome's built-in model",
  description: "A language model for this app that is part of Chrome and runs on your own computer. No key, nothing to pay, and what you ask stays on this device. Only in Chrome on a computer that has its built-in model.",
  version: "1.0.0",
  permissions: ["provide:llm", "device-model"],
  services: ["llm", "device-model"],
};

const MODEL = "chrome-built-in";
/** What stands for "no tool: here is the answer". Not a name a tool can have (they have no spaces), so no tool is mistaken for it. */
const NONE = "no tool";

/** What the model is told about a request's tools, since it has no tool calls of its own. */
const toolsNote = (tools) =>
  `You can use tools. Answer with JSON only: {"tool": "<name>", "args": {…}} to use one, or {"tool": "${NONE}", "answer": …} when you have the answer. Use one tool at a time, then wait for what it says.\nThe tools:\n${tools
    .map((t) => `- ${t.name}: ${t.description ?? ""} Arguments (JSON Schema): ${JSON.stringify(t.parameters ?? { type: "object", properties: {} })}`)
    .join("\n")}`;

/** The shape asked for when a request has tools: which tool and its arguments, or the answer. */
const toolsSchema = (tools, answer) => ({
  type: "object",
  properties: { tool: { type: "string", enum: [...tools.map((t) => t.name), NONE] }, args: { type: "object" }, answer: answer ?? { type: "string" } },
  required: ["tool"],
});

/** The platform's messages as the browser model's turns: a tool call as the JSON the model wrote, a tool's answer as the person's turn. */
function toTurns(messages) {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "user", content: `The ${m.name} tool answered:\n${m.content}` };
    if (m.role === "assistant" && m.toolCalls?.length) return { role: "assistant", content: JSON.stringify({ tool: m.toolCalls[0].name, args: m.toolCalls[0].args ?? {} }) };
    return { role: m.role, content: m.content ?? "" };
  });
}

export default function (ctx) {
  /** Whether the browser has a model, or can download one. Asked each time: a download finishes, a tab moves to another browser profile. */
  const state = async () => (await ctx.call("device-model", "state").catch(() => ({ state: "unavailable" }))).state;
  let calls = 0;

  ctx.on("llm:providers", async (value) => {
    if ((await state()) === "unavailable") return value;
    // Ready without a key: there is none to give.
    return { providers: [...value.providers, { id: manifest.id, name: "Chrome's built-in model", model: MODEL, ready: true }] };
  });

  ctx.on("llm:models", ({ provider }) => {
    if (provider !== manifest.id) return undefined;
    return { models: [{ id: MODEL, name: "Chrome's built-in model" }], tiers: { best: MODEL, balanced: MODEL, fast: MODEL } };
  });

  ctx.on("llm:complete", async (request) => {
    if (request.provider !== manifest.id) return undefined;
    try {
      const tools = request.tools ?? [];
      const system = [request.system, tools.length ? toolsNote(tools) : ""].filter(Boolean).join("\n\n");
      const schema = tools.length ? toolsSchema(tools, request.schema) : request.schema;
      const reply = await ctx.call("device-model", "prompt", { ...(system ? { system } : {}), turns: toTurns(request.messages), ...(schema ? { schema } : {}) });
      const answer = { text: reply.text, toolCalls: [], stop: "end", usage: { input: reply.input, output: reply.output }, model: MODEL };
      if (tools.length) {
        let said;
        try {
          said = JSON.parse(reply.text);
        } catch {
          return { error: "Chrome's built-in model didn't answer in the shape asked for. Ask again, or pick a larger model for this." };
        }
        if (said?.tool && said.tool !== NONE) {
          if (!tools.some((t) => t.name === said.tool)) return { error: `Chrome's built-in model asked for a tool that isn't there (${String(said.tool).slice(0, 60)}). Ask again, or pick a larger model for this.` };
          return { ...answer, text: "", toolCalls: [{ id: `call-${++calls}`, name: said.tool, args: said.args && typeof said.args === "object" ? said.args : {} }], stop: "tool" };
        }
        if (request.schema) return { ...answer, text: JSON.stringify(said?.answer ?? null), json: said?.answer };
        return { ...answer, text: typeof said?.answer === "string" ? said.answer : JSON.stringify(said?.answer ?? "") };
      }
      if (request.schema) answer.json = JSON.parse(reply.text);
      return answer;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
