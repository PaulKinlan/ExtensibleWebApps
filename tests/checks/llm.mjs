// The llm service (std/llm/module.ts) and the vendor plugins behind it
// (std/llm/anthropic.js, std/llm/openai.js, std/llm/gemini.js). A small server
// on this computer stands in for all three vendors' APIs: each plugin is
// installed from its own file with its API's address pointed at it, so the
// test covers the plugin's real translation to and from that vendor's format.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = 4176;
const LOCAL = `localhost:${PORT}`;

/** A pretend vendor: a tool call when tools are offered and none has answered yet, JSON when asked for it, else text. */
function answer(vendor, body, url) {
  if (vendor === "anthropic") {
    if (body.model === "broken") return [400, { error: { message: "model broken not found" } }];
    const last = body.messages.at(-1);
    const answered = Array.isArray(last.content) && last.content[0]?.type === "tool_result";
    if (body.output_config) return [200, { model: body.model, content: [{ type: "text", text: '{"answer":42}' }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } }];
    if (body.tools && !answered) return [200, { model: body.model, content: [{ type: "thinking", thinking: "", signature: "sig-1" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "tu1", name: body.tools[0].name, input: { q: "kettle" } }], stop_reason: "tool_use", usage: { input_tokens: 7, output_tokens: 4 } }];
    return [200, { model: body.model, content: [{ type: "text", text: `anthropic heard ${answered ? last.content[0].content : last.content}` }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 3 } }];
  }
  if (vendor === "openai") {
    const last = body.input.at(-1);
    const reply = (output) => [200, { model: body.model, status: "completed", output, usage: { input_tokens: 6, output_tokens: 2 } }];
    if (body.text?.format) return reply([{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"answer":42}' }] }]);
    if (body.tools && last.type !== "function_call_output") return reply([{ type: "reasoning", id: "rs_1", encrypted_content: "enc-1" }, { type: "function_call", call_id: "call_1", name: body.tools[0].name, arguments: '{"q":"kettle"}' }]);
    return reply([{ type: "message", role: "assistant", content: [{ type: "output_text", text: `openai heard ${last.output ?? last.content}` }] }]);
  }
  if (vendor === "compatible") {
    const last = body.messages.at(-1);
    const reply = (message, finish) => [200, { model: body.model, choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 6, completion_tokens: 2 } }];
    if (body.response_format) return reply({ role: "assistant", content: '{"answer":42}' }, "stop");
    if (body.tools && last.role !== "tool") return reply({ role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: body.tools[0].function.name, arguments: '{"q":"kettle"}' } }] }, "tool_calls");
    return reply({ role: "assistant", content: `ollama heard ${last.content}` }, "stop");
  }
  const model = decodeURIComponent(url.split("/models/")[1].split(":")[0]);
  const last = body.contents.at(-1).parts[0];
  const reply = (parts, finishReason = "STOP") => [200, { modelVersion: model, candidates: [{ content: { role: "model", parts }, finishReason }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } }];
  if (body.generationConfig?.responseJsonSchema) return reply([{ text: '{"answer":42}' }]);
  if (body.tools && !last.functionResponse) return reply([{ functionCall: { name: body.tools[0].functionDeclarations[0].name, args: { q: "kettle" } }, thoughtSignature: "thought-1" }]);
  return reply([{ text: `gemini heard ${last.functionResponse ? last.functionResponse.response.content : last.text}` }]);
}

/** Each vendor's live model list: newer models than the plugins' fallbacks, so a tier has to be looked up to find them. */
const MODELS = {
  anthropic: { data: [{ id: "claude-opus-5-5" }, { id: "claude-opus-6" }, { id: "claude-sonnet-5-5" }, { id: "claude-haiku-5-5" }, { id: "claude-fable-5-1" }] },
  openai: { data: [{ id: "gpt-6-astra" }, { id: "gpt-6.2-astra" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] },
  compatible: { data: [{ id: "llama3.2" }] },
  gemini: { models: [{ name: "models/gemini-4-argon", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-4.1-flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] }] },
};

/** A std vendor plugin, with its API's address and host pointed at the test server. */
function vendorSource(file, api, host) {
  return readFileSync(new URL(`../../std/llm/${file}`, import.meta.url), "utf8").replaceAll(api, `http://${LOCAL}${new URL(api).pathname.replace(/\/$/, "")}`).replaceAll(host, LOCAL);
}

export default async function ({ a, check, plugin, pluginLog, traceHas }) {
  const received = [];
  const server = createServer((req, res) => {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const h = req.headers;
      const vendor = req.url.startsWith("/v1beta") ? "gemini" : h["x-api-key"] ? "anthropic" : h.authorization ? "openai" : "compatible";
      const body = JSON.parse(raw || "{}");
      received.push({ vendor, url: req.url, headers: req.headers, body });
      const [status, data] = req.method === "GET" ? [200, MODELS[vendor]] : answer(vendor, body, req.url);
      res.writeHead(status, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(data));
    });
  });
  await new Promise((resolve) => server.listen(PORT, "localhost", resolve));
  const ids = ["asker", "lonely", "nollm", "pretender", "llm-anthropic", "llm-openai", "llm-openai-compatible", "llm-gemini"];
  try {
    // With no provider in the app, a request says what to add.
    await plugin(`export const manifest = { id: 'lonely', name: 'Lonely', permissions: ['llm'] };
export default async (ctx) => { ctx.log('lonely ' + await ctx.call('llm', 'complete', { messages: [{ role: 'user', content: 'hi' }] }).then(() => 'answered', (e) => e.message)); };`);
    check("asking with no provider in the app says to add one from Customize", /no language model yet\. Add one from Customize/.test(await pluginLog("lonely", "lonely").catch(() => "")));
    await plugin(`export const manifest = { id: 'nollm', name: 'No llm', permissions: [] };
export default async (ctx) => { ctx.log('nollm ' + await ctx.call('llm', 'providers').then(() => 'answered', (e) => e.message)); };`);
    check("calling llm needs the llm permission", /Missing capability llm/.test(await pluginLog("nollm", "nollm").catch(() => "")));
    await plugin(`export const manifest = { id: 'pretender', name: 'Pretender', permissions: ['hook:intercept:llm:complete'] };
export default (ctx) => { ctx.on('llm:complete', () => ({ text: 'stolen' })); };`);
    const refused = await a.waitForFunction(() => window.__host.traces.some((e) => e.kind === "denied" && e.plugin === "pretender" && e.name === "provide:llm"), null, { timeout: 5000 }).then(() => true, () => false);
    check("answering llm requests needs provide:llm, not the usual hook permission", refused);

    await plugin(vendorSource("anthropic.js", "https://api.anthropic.com", "api.anthropic.com"));
    await plugin(vendorSource("openai.js", "https://api.openai.com/v1", "api.openai.com"));
    await plugin(vendorSource("openai-compatible.js", "http://localhost:11434/v1", "localhost:11434"));
    await plugin(vendorSource("gemini.js", "https://generativelanguage.googleapis.com", "generativelanguage.googleapis.com"));

    // One plugin asks each provider in turn: plain text, a tool call and its answer, and JSON of a shape.
    await plugin(`export const manifest = { id: 'asker', name: 'Asker', permissions: ['llm'] };
export default async (ctx) => {
  ctx.log('asker-providers ' + JSON.stringify(await ctx.call('llm', 'providers')));
  const tools = [{ name: 'search', description: 'Searches the notes', parameters: { type: 'object', properties: { q: { type: 'string' } } } }];
  for (const provider of ['llm-anthropic', 'llm-openai', 'llm-openai-compatible', 'llm-gemini']) {
    try {
      const plain = await ctx.call('llm', 'complete', { provider, system: 'Be brief.', messages: [{ role: 'user', content: 'hello' }] });
      ctx.log('asker-plain ' + provider + ' ' + JSON.stringify(plain));
      const asked = [{ role: 'user', content: 'find the kettle note' }];
      const first = await ctx.call('llm', 'complete', { provider, messages: asked, tools });
      const call = first.toolCalls[0];
      const second = await ctx.call('llm', 'complete', { provider, tools, messages: [...asked, first.message, { role: 'tool', id: call.id, name: call.name, content: 'kettle is on shelf 2' }] });
      ctx.log('asker-tools ' + provider + ' ' + JSON.stringify({ stop: first.stop, call, text: second.text }));
      const shaped = await ctx.call('llm', 'complete', { provider, messages: [{ role: 'user', content: 'the answer?' }], schema: { type: 'object', properties: { answer: { type: 'number' } } } });
      ctx.log('asker-json ' + provider + ' ' + JSON.stringify(shaped.json));
      ctx.log('asker-models ' + provider + ' ' + JSON.stringify((await ctx.call('llm', 'models', provider)).tiers));
    } catch (e) { ctx.log('asker-failed ' + provider + ' ' + e.message); }
  }
  ctx.log('asker-broken ' + await ctx.call('llm', 'complete', { provider: 'llm-anthropic', model: 'broken', messages: [{ role: 'user', content: 'hi' }] }).then(() => 'answered', (e) => e.message));
  ctx.log('asker-shape ' + await ctx.call('llm', 'complete', { provider: 'llm-anthropic', messages: [{ role: 'user', content: 'the answer?' }], schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } } }).then((a) => 'answered ' + JSON.stringify(a.json), (e) => e.message));
  ctx.log('asker-unsupported ' + await ctx.call('llm', 'complete', { messages: [{ role: 'user', content: 'hi' }], schema: { type: 'object', patternProperties: {} } }).then(() => 'answered', (e) => e.message));
  ctx.log('asker-bad ' + await ctx.call('llm', 'complete', { messages: [{ role: 'assistant', content: 'hi' }] }).then(() => 'answered', (e) => e.message));
  ctx.log('asker-default ' + (await ctx.call('llm', 'complete', { messages: [{ role: 'user', content: 'anyone' }] })).provider);
  ctx.log('asker-absent ' + await ctx.call('llm', 'complete', { provider: 'llm-nobody', messages: [{ role: 'user', content: 'anyone' }] }).then((r) => 'answered by ' + r.provider, (e) => e.message));
  ctx.log('asker-done');
};`);
    const providers = await pluginLog("asker", "asker-providers").catch(() => "");
    check("llm.providers lists every provider in the app, none ready before it has a key", ["llm-anthropic", "llm-openai", "llm-gemini"].every((id) => providers.includes(`"id":"${id}","name"`) && !providers.includes(`"id":"${id}","name":"[^"]*","model":"[^"]*","ready":true`)), providers);
    // Each provider asks for its key the first time; the person pastes one into the kernel's card.
    for (const key of ["anthropic-key", "openai-key", "gemini-key"]) {
      const field = await a.waitForSelector('[data-key^="secrets:"] input[type=password]', { timeout: 10000 }).catch(() => null);
      await field?.fill(key);
      await field?.press("Tab");
      await a.click('[data-key^="secrets:"] button:has-text("Save")').catch(() => {});
      await a.waitForSelector('[data-key^="secrets:"]', { state: "detached", timeout: 5000 }).catch(() => {});
    }
    await pluginLog("asker", "asker-done").catch(() => "");
    // The space keeps llm-openai's lines apart from llm-openai-compatible's.
    const log = async (prefix) => pluginLog("asker", `${prefix} `).catch(() => "");
    const sent = (vendor) => received.filter((r) => r.vendor === vendor);
    const failures = await a.evaluate(() => window.__host.traces.filter((e) => e.plugin === "asker" && e.detail?.startsWith("asker-failed")).map((e) => e.detail).join("; "));
    check("every provider answers every kind of request", !failures, failures);

    // Anthropic: the key in x-api-key, the system prompt and tools in Anthropic's places, a tool's answer as a tool_result.
    const anthropic = sent("anthropic").filter((r) => r.body.messages);
    check("llm-anthropic answers plain text in the platform's shape, with the best tier as the newest Opus in the live list", (await log("asker-plain llm-anthropic")).includes('"text":"anthropic heard hello","toolCalls":[],"stop":"end","usage":{"input":2,"output":3},"provider":"llm-anthropic","model":"claude-opus-6"'), await log("asker-plain llm-anthropic"));
    check("llm-anthropic sends the key the person gave as x-api-key, with the system prompt in its own field", anthropic.length > 0 && sent("anthropic").every((r) => r.headers["x-api-key"] === "anthropic-key" && r.headers["anthropic-version"]) && anthropic[0].body.system === "Be brief.");
    check("llm-anthropic turns a tool call and its answer into tool_use and tool_result", (await log("asker-tools llm-anthropic")) === 'asker-tools llm-anthropic {"stop":"tool","call":{"id":"tu1","name":"search","args":{"q":"kettle"}},"text":"anthropic heard kettle is on shelf 2"}' && anthropic.some((r) => r.body.messages.at(-1).content[0]?.tool_use_id === "tu1"), await log("asker-tools llm-anthropic"));
    check("llm-anthropic sends Claude's turn back as it came, thinking included, through the answer's message", anthropic.some((r) => r.body.messages.some((m) => m.role === "assistant" && m.content[0]?.signature === "sig-1")));
    check("llm-anthropic asks for a JSON Schema with output_config and returns the value", (await log("asker-json llm-anthropic")) === 'asker-json llm-anthropic {"answer":42}' && anthropic.some((r) => r.body.output_config?.format?.type === "json_schema"));
    check("llm.models gives each tier's newest model from Anthropic's live list", (await log("asker-models llm-anthropic")) === 'asker-models llm-anthropic {"best":"claude-opus-6","balanced":"claude-sonnet-5-5","fast":"claude-haiku-5-5"}', await log("asker-models llm-anthropic"));
    check("a provider's error reaches the caller with the provider's name", /Claude: model broken not found/.test(await log("asker-broken")), await log("asker-broken"));

    // OpenAI: the Responses API, the key as a bearer token, the system prompt as instructions, reasoning sent back.
    const openai = sent("openai").filter((r) => r.body.input);
    check("llm-openai answers plain text through the Responses API, with the key as a bearer token and the system prompt as instructions", (await log("asker-plain llm-openai")).includes('"text":"openai heard hello"') && sent("openai").every((r) => r.headers.authorization === "Bearer openai-key") && openai[0]?.url === "/v1/responses" && openai[0].body.instructions === "Be brief." && openai[0].body.store === false, await log("asker-plain llm-openai"));
    check("llm-openai's best tier is the newest Astra in the live list", (await log("asker-plain llm-openai")).includes('"model":"gpt-6.2-astra"'));
    check("llm-openai sends a tool's answer as function_call_output, after the model's reasoning", (await log("asker-tools llm-openai")) === 'asker-tools llm-openai {"stop":"tool","call":{"id":"call_1","name":"search","args":{"q":"kettle"}},"text":"openai heard kettle is on shelf 2"}' && openai.some((r) => r.body.input.at(-1).call_id === "call_1" && r.body.input.some((i) => i.encrypted_content === "enc-1")), await log("asker-tools llm-openai"));
    check("llm-openai asks for a JSON Schema with text.format", (await log("asker-json llm-openai")) === 'asker-json llm-openai {"answer":42}');

    // OpenAI-compatible (Ollama): Chat Completions, no key, the first listed model when none is set.
    const compatible = sent("compatible").filter((r) => r.body.messages);
    check("llm-openai-compatible answers with no key, using the first model the server lists", (await log("asker-plain llm-openai-compatible")).includes('"text":"ollama heard hello"') && (await log("asker-plain llm-openai-compatible")).includes('"model":"llama3.2"') && compatible.every((r) => !r.headers.authorization) && compatible[0]?.body.messages[0].role === "system", await log("asker-plain llm-openai-compatible"));
    check("llm-openai-compatible turns a tool call and its answer into tool_calls and a tool message", (await log("asker-tools llm-openai-compatible")).includes('"text":"ollama heard kettle is on shelf 2"') && compatible.some((r) => r.body.messages.at(-1).tool_call_id === "call_9"), await log("asker-tools llm-openai-compatible"));

    // Gemini: the key as x-goog-api-key, a system instruction, a tool's answer as a functionResponse after the thought signature.
    const gemini = sent("gemini").filter((r) => r.body.contents);
    check("llm-gemini answers plain text, and sends the key as x-goog-api-key with a system instruction", (await log("asker-plain llm-gemini")).includes('"text":"gemini heard hello"') && sent("gemini").every((r) => r.headers["x-goog-api-key"] === "gemini-key") && gemini[0]?.body.systemInstruction?.parts[0].text === "Be brief." && gemini[0].url.includes("/gemini-4-argon:generateContent"), await log("asker-plain llm-gemini"));
    check("llm-gemini turns a tool call and its answer into functionCall and functionResponse, keeping the thought signature", (await log("asker-tools llm-gemini")).includes('"text":"gemini heard kettle is on shelf 2"') && gemini.some((r) => r.body.contents.some((c) => c.role === "model" && c.parts[0]?.thoughtSignature === "thought-1")), await log("asker-tools llm-gemini"));
    check("llm-gemini asks for a JSON Schema with responseJsonSchema", (await log("asker-json llm-gemini")) === 'asker-json llm-gemini {"answer":42}');
    check("llm-gemini's tiers come from Google's live list, newest version first", (await log("asker-models llm-gemini")) === 'asker-models llm-gemini {"best":"gemini-4-argon","balanced":"gemini-4.1-flash","fast":"gemini-3.5-flash-lite"}', await log("asker-models llm-gemini"));

    check("an answer that isn't of the schema's shape is an error, not a value", /isn't of the shape asked for: answer/.test(await log("asker-shape")), await log("asker-shape"));
    check("a schema outside the platform's JSON Schema subset is refused before any vendor is asked", /patternProperties/.test(await log("asker-unsupported")), await log("asker-unsupported"));
    check("the kernel refuses a request whose first message isn't the person's", /first message is the person's/.test(await log("asker-bad")), await log("asker-bad"));
    check("a provider that is named and isn't in the app is an error, never another vendor's answer", /^asker-absent No provider llm-nobody in this app/.test(await log("asker-absent")), await log("asker-absent"));
    check("without a provider named, the first ready one answers", /asker-default llm-(anthropic|openai|gemini)/.test(await log("asker-default")));
    check("the trace records each answer: provider, model, how it stopped and the tokens", await traceHas(a, (e) => e.name === "llm:complete" && e.plugin === "asker" && /llm-openai \S+ tool, 6 in, 2 out/.test(e.detail ?? "")));
  } finally {
    for (const id of ids) await a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
    for (const name of ["anthropic", "openai", "gemini"]) {
      await plugin(`export const manifest = { id: 'forget-${name}', name: 'Forget', permissions: ['secret:${name}'] };
export default async (ctx) => { await ctx.call('secrets', 'forget', '${name}'); };`).catch(() => {});
      await a.evaluate((id) => window.__host.command("uninstall", id), `forget-${name}`).catch(() => {});
    }
    server.close();
  }
}
