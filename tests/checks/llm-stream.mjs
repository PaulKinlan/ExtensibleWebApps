// Streaming (`llm.stream`, `llm:stream`, `llm:chunk`), multimodal user messages,
// fallback from `llm:stream` to `llm:complete`, and live streaming updates in
// `std/ask-the-page.js` and `std/agents/chat.js`.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const MODELS = {
  anthropic: { data: [{ id: "claude-opus-6" }] },
  openai: { data: [{ id: "gpt-6.2-astra" }] },
  compatible: { data: [{ id: "llama3.2" }] },
  gemini: { models: [{ name: "models/gemini-4-argon", supportedGenerationMethods: ["generateContent"] }] },
};

function sseResponse(vendor, body, url) {
  if (vendor === "anthropic") {
    const events = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: body.model, usage: { input_tokens: 8, output_tokens: 0 } } })}`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Claude " } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streams!" } })}`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })}`,
    ];
    return `${events.join("\n\n")}\n\n`;
  }
  if (vendor === "openai") {
    const completed = {
      model: body.model,
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OpenAI streams!" }] }],
      usage: { input_tokens: 9, output_tokens: 4 },
    };
    const events = [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "OpenAI " })}`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "streams!" })}`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}`,
    ];
    return `${events.join("\n\n")}\n\n`;
  }
  if (vendor === "compatible") {
    const events = [
      `data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: "Ollama " }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: "streams!" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 4 } })}`,
      "data: [DONE]",
    ];
    return `${events.join("\n\n")}\n\n`;
  }
  const model = decodeURIComponent(url.split("/models/")[1].split(":")[0]);
  const events = [
    `data: ${JSON.stringify({ modelVersion: model, candidates: [{ content: { role: "model", parts: [{ text: "Gemini " }] } }] })}`,
    `data: ${JSON.stringify({ modelVersion: model, candidates: [{ content: { role: "model", parts: [{ text: "streams!" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 4 } })}`,
  ];
  return `${events.join("\n\n")}\n\n`;
}

function jsonResponse(vendor, body, url) {
  if (vendor === "anthropic") {
    return { model: body.model, content: [{ type: "text", text: "multimodal anthropic ok" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } };
  }
  if (vendor === "openai") {
    return { model: body.model, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "multimodal openai ok" }] }], usage: { input_tokens: 5, output_tokens: 3 } };
  }
  if (vendor === "compatible") {
    return { model: body.model, choices: [{ message: { role: "assistant", content: "multimodal compatible ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
  }
  const model = decodeURIComponent(url.split("/models/")[1].split(":")[0]);
  return { modelVersion: model, candidates: [{ content: { role: "model", parts: [{ text: "multimodal gemini ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } };
}

function vendorSource(file, api, host, local) {
  return readFileSync(new URL(`../../std/llm/${file}`, import.meta.url), "utf8")
    .replaceAll(api, `http://${local}${new URL(api).pathname.replace(/\/$/, "")}`)
    .replaceAll(host, local);
}

export default async function ({ a, check, openTab, URL: siteUrl, plugin, pluginLog }) {
  const received = [];
  const server = createServer((req, res) => {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const h = req.headers;
      const vendor = req.url.startsWith("/v1beta") ? "gemini" : h["x-api-key"] ? "anthropic" : h.authorization ? "openai" : "compatible";
      if (req.method === "GET") {
        return res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(MODELS[vendor]));
      }
      const body = JSON.parse(raw || "{}");
      received.push({ vendor, url: req.url, headers: req.headers, body });
      const wantsStream = body.stream === true || req.url.includes(":streamGenerateContent");
      if (wantsStream) {
        res.writeHead(200, { ...cors, "Content-Type": "text/event-stream" }).end(sseResponse(vendor, body, req.url));
      } else {
        res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(jsonResponse(vendor, body, req.url)));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "localhost", resolve));
  const local = `localhost:${server.address().port}`;

  const ids = [
    "no-llm-chunk",
    "no-provide-chunk",
    "unready-provider",
    "fallback-provider",
    "llm-anthropic",
    "llm-openai",
    "llm-openai-compatible",
    "llm-gemini",
    "stream-tester",
  ];

  try {
    // 1. Hook & method permission gates for streaming.
    await plugin(`export const manifest = { id: 'no-llm-chunk', name: 'No llm chunk', permissions: [] };
export default (ctx) => { ctx.on('llm:chunk', () => {}); };`);
    const deniedListen = await a.waitForFunction(() => window.__host.traces.some((e) => e.kind === "denied" && e.plugin === "no-llm-chunk" && e.name === "llm"), null, { timeout: 5000 }).then(() => true, () => false);
    check("listening to llm:chunk requires the llm permission", deniedListen);

    await plugin(`export const manifest = { id: 'no-provide-chunk', name: 'No provide chunk', permissions: ['llm'] };
export default async (ctx) => {
  ctx.log('spoof ' + await ctx.call('llm', 'chunk', 's1', 'spoofed').then(() => 'ok', (e) => e.message));
};`);
    check("calling llm.chunk requires provide:llm", /Missing capability provide:llm/.test(await pluginLog("no-provide-chunk", "spoof").catch(() => "")));

    // 2. Unready provider + fallback provider (only implements llm:complete).
    await plugin(`export const manifest = { id: 'unready-provider', name: 'Unready provider', permissions: ['provide:llm'] };
export default (ctx) => {
  ctx.on('llm:providers', (v) => ({ providers: [...v.providers, { id: 'unready-provider', name: 'Unready provider', ready: false }] }));
  ctx.on('llm:complete', (req) => {
    if (req.provider !== 'unready-provider') return;
    return { error: 'not ready yet', declined: true };
  });
};`);
    await plugin(`export const manifest = { id: 'fallback-provider', name: 'Fallback provider', permissions: ['provide:llm'] };
export default (ctx) => {
  ctx.on('llm:providers', (v) => ({ providers: [...v.providers, { id: 'fallback-provider', name: 'Fallback provider', ready: true }] }));
  ctx.on('llm:complete', (req) => {
    if (req.provider !== 'fallback-provider') return;
    return { text: 'Fallback streams cleanly', stop: 'end', model: 'fb-1', usage: { input: 3, output: 3 } };
  });
};`);

    await plugin(vendorSource("anthropic.js", "https://api.anthropic.com", "api.anthropic.com", local));
    await plugin(vendorSource("openai.js", "https://api.openai.com/v1", "api.openai.com", local));
    await plugin(vendorSource("openai-compatible.js", "http://localhost:11434/v1", "localhost:11434", local));
    await plugin(vendorSource("gemini.js", "https://generativelanguage.googleapis.com", "generativelanguage.googleapis.com", local));

    // Seed the three vendor keys once so requests don't pause on key cards.
    for (const [name, host, val] of [["anthropic", local, "ant-k"], ["openai", local, "oai-k"], ["gemini", local, "gem-k"]]) {
      await plugin(`export const manifest = { id: 'seed-${name}', name: 'Seed', permissions: ['secret:${name}'] };
export default async (ctx) => { await ctx.call('secrets', 'request', '${name}', { hosts: ['${host}'], label: '${name}' }); };`);
      const field = await a.waitForSelector('[data-key^="secrets:"] input[type=password]', { timeout: 8000 }).catch(() => null);
      await field?.fill(val);
      await field?.press("Tab");
      await a.click('[data-key^="secrets:"] button:has-text("Save")').catch(() => {});
      await a.waitForSelector('[data-key^="secrets:"]', { state: "detached", timeout: 5000 }).catch(() => {});
      await a.evaluate((id) => window.__host.command("uninstall", id), `seed-${name}`).catch(() => {});
    }

    await plugin(`export const manifest = { id: 'stream-tester', name: 'Stream tester', permissions: ['llm'] };
export default async (ctx) => {
  const byStream = new Map();
  ctx.on('llm:chunk', ({ streamId, delta, done }) => {
    const list = byStream.get(streamId) ?? [];
    list.push({ delta, done });
    byStream.set(streamId, list);
  });

  const providers = await ctx.call('llm', 'providers');
  const unreadyEntry = providers.find((p) => p.id === 'unready-provider');
  ctx.log('unready-entry ' + JSON.stringify(unreadyEntry ?? null));

  // Default provider selection skips unready-provider and picks the first ready provider.
  const defaultAns = await ctx.call('llm', 'stream', { streamId: 'def-1', messages: [{ role: 'user', content: 'who answers?' }] });
  ctx.log('default-stream ' + JSON.stringify({ provider: defaultAns.provider, text: defaultAns.text, streamId: defaultAns.streamId, chunks: byStream.get('def-1') }));

  // Explicit call to absent provider fails cleanly.
  const absentErr = await ctx.call('llm', 'complete', { provider: 'llm-absent', messages: [{ role: 'user', content: 'hi' }] }).then(() => 'ok', (e) => e.message);
  ctx.log('absent-err ' + absentErr);

  // SSE streaming across all four vendor providers.
  for (const p of ['llm-anthropic', 'llm-openai', 'llm-openai-compatible', 'llm-gemini']) {
    const sid = 'sse-' + p;
    const ans = await ctx.call('llm', 'stream', { provider: p, streamId: sid, messages: [{ role: 'user', content: 'stream please' }] });
    ctx.log('sse ' + p + ' ' + JSON.stringify({ text: ans.text, provider: ans.provider, streamId: ans.streamId, stop: ans.stop, message: ans.message, chunks: byStream.get(sid) }));
  }

  // Multimodal validation errors.
  const badEmpty = await ctx.call('llm', 'complete', { messages: [{ role: 'user', content: [] }] }).then(() => 'ok', (e) => e.message);
  const badImg = await ctx.call('llm', 'complete', { messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/svg+xml', data: 'YWJj' }] }] }).then(() => 'ok', (e) => e.message);
  const badAud = await ctx.call('llm', 'complete', { messages: [{ role: 'user', content: [{ type: 'audio', mediaType: 'text/plain', data: 'YWJj' }] }] }).then(() => 'ok', (e) => e.message);
  ctx.log('mm-validation ' + JSON.stringify({ badEmpty, badImg, badAud }));

  // Multimodal translation across all four vendor providers (with data:...;base64, prefix stripping).
  const mmParts = [
    { type: 'text', text: 'Inspect media' },
    { type: 'image', mediaType: 'image/png', data: 'data:image/png;base64,aGVsbG8=' },
    { type: 'audio', mediaType: 'audio/mpeg', data: 'data:audio/mpeg;base64,d29ybGQ=' },
  ];
  for (const p of ['llm-anthropic', 'llm-openai', 'llm-openai-compatible', 'llm-gemini']) {
    const ans = await ctx.call('llm', 'complete', { provider: p, messages: [{ role: 'user', content: mmParts }] });
    ctx.log('mm-ok ' + p + ' ' + ans.text);
  }
  ctx.log('stream-tester-done');
};`);

    await pluginLog("stream-tester", "stream-tester-done");
    const log = (prefix) => pluginLog("stream-tester", prefix).catch(() => "");

    const unreadyEntry = JSON.parse((await log("unready-entry ")).slice("unready-entry ".length) || "null");
    check("llm.providers includes unready providers with ready: false", unreadyEntry?.id === "unready-provider" && unreadyEntry?.ready === false, JSON.stringify(unreadyEntry));

    const defStream = JSON.parse((await log("default-stream ")).slice("default-stream ".length) || "{}");
    const defJoined = (defStream.chunks ?? []).filter((c) => !c.done).map((c) => c.delta).join("");
    check(
      "llm.stream skips unready providers, falls back to llm:complete when llm:stream returns undefined, and emits chunks + done: true",
      defStream.provider === "fallback-provider" && defStream.streamId === "def-1" && defStream.text === "Fallback streams cleanly" && defJoined === "Fallback streams cleanly" && defStream.chunks?.at(-1)?.done === true,
      JSON.stringify(defStream),
    );
    check("explicitly asking an absent provider fails cleanly", /No provider llm-absent/.test(await log("absent-err ")));

    // Verify SSE chunks and final shapes for all 4 providers.
    for (const [id, expectedDeltas] of [
      ["llm-anthropic", ["Claude ", "streams!"]],
      ["llm-openai", ["OpenAI ", "streams!"]],
      ["llm-openai-compatible", ["Ollama ", "streams!"]],
      ["llm-gemini", ["Gemini ", "streams!"]],
    ]) {
      const entry = JSON.parse((await log(`sse ${id} `)).slice(`sse ${id} `.length) || "{}");
      const deltas = (entry.chunks ?? []).filter((c) => !c.done).map((c) => c.delta);
      const doneChunk = entry.chunks?.at(-1);
      check(
        `${id} parses SSE responses in llm:stream and emits live deltas followed by done: true`,
        JSON.stringify(deltas) === JSON.stringify(expectedDeltas) && entry.text === expectedDeltas.join("") && entry.message?.content === expectedDeltas.join("") && doneChunk?.done === true && entry.streamId === `sse-${id}`,
        JSON.stringify(entry),
      );
    }

    // Verify multimodal validation & vendor translation.
    const mmVal = JSON.parse((await log("mm-validation ")).slice("mm-validation ".length) || "{}");
    check(
      "checkRequest rejects empty content arrays, unsupported image media types, and non-audio media types",
      /empty/.test(mmVal.badEmpty) && /image\/png/.test(mmVal.badImg) && /audio\//.test(mmVal.badAud),
      JSON.stringify(mmVal),
    );

    const antMm = received.find((r) => r.vendor === "anthropic" && !r.body.stream)?.body?.messages?.[0]?.content;
    check(
      "llm-anthropic translates multimodal text, image and audio parts with stripped base64 data",
      Array.isArray(antMm) && antMm[0]?.text === "Inspect media" && antMm[1]?.type === "image" && antMm[1]?.source?.media_type === "image/png" && antMm[1]?.source?.data === "aGVsbG8=" && antMm[2]?.type === "audio" && antMm[2]?.source?.data === "d29ybGQ=",
      JSON.stringify(antMm),
    );
    const oaiMm = received.find((r) => r.vendor === "openai" && !r.body.stream)?.body?.input?.[0]?.content;
    check(
      "llm-openai translates multimodal parts to input_text, input_image data URL, and input_audio",
      Array.isArray(oaiMm) && oaiMm[0]?.type === "input_text" && oaiMm[1]?.type === "input_image" && oaiMm[1]?.image_url === "data:image/png;base64,aGVsbG8=" && oaiMm[2]?.type === "input_audio" && oaiMm[2]?.input_audio?.data === "d29ybGQ=" && oaiMm[2]?.input_audio?.format === "mp3",
      JSON.stringify(oaiMm),
    );
    const compatMm = received.find((r) => r.vendor === "compatible" && !r.body.stream)?.body?.messages?.[0]?.content;
    check(
      "llm-openai-compatible translates multimodal parts to text, image_url and input_audio",
      Array.isArray(compatMm) && compatMm[0]?.type === "text" && compatMm[1]?.type === "image_url" && compatMm[1]?.image_url?.url === "data:image/png;base64,aGVsbG8=" && compatMm[2]?.type === "input_audio" && compatMm[2]?.input_audio?.format === "mp3",
      JSON.stringify(compatMm),
    );
    const gemMm = received.find((r) => r.vendor === "gemini" && !r.url.includes(":streamGenerateContent"))?.body?.contents?.[0]?.parts;
    check(
      "llm-gemini translates multimodal parts to text and inlineData with stripped base64",
      Array.isArray(gemMm) && gemMm[0]?.text === "Inspect media" && gemMm[1]?.inlineData?.mimeType === "image/png" && gemMm[1]?.inlineData?.data === "aGVsbG8=" && gemMm[2]?.inlineData?.mimeType === "audio/mpeg" && gemMm[2]?.inlineData?.data === "d29ybGQ=",
      JSON.stringify(gemMm),
    );

    // 3. Live UI streaming updates in std/ask-the-page.js and std/agents/chat.js (direct mode).
    const tab = await openTab(`${siteUrl}demos/habits/app.html`);
    try {
      const gatedModel = `export const manifest = { id: "gated-stream", name: "Gated stream", permissions: ["provide:llm"], services: ["llm"] };
export default (ctx) => {
  let release;
  ctx.on("llm:providers", (v) => ({ providers: [...v.providers, { id: "gated-stream", name: "Gated stream", ready: true }] }));
  ctx.on("llm:stream", async (req) => {
    if (req.provider !== "gated-stream") return;
    await ctx.call("llm", "chunk", req.streamId, "First part… ");
    await new Promise((r) => { release = r; setTimeout(r, 4000); });
    await ctx.call("llm", "chunk", req.streamId, "second part!");
    return { text: "First part… second part!", stop: "end", model: "gated-1", usage: { input: 4, output: 4 } };
  });
  ctx.on("plugins:changed", () => release?.());
};`;
      const askCode = readFileSync(new URL("../../std/ask-the-page.js", import.meta.url), "utf8");
      const askHtml = readFileSync(new URL("../../std/ask-the-page.html", import.meta.url), "utf8");
      const chatCode = readFileSync(new URL("../../std/agents/chat.js", import.meta.url), "utf8");
      const chatHtml = readFileSync(new URL("../../std/agents/chat.html", import.meta.url), "utf8");

      await tab.evaluate((data) => window.__host.command("user:add", { app: "demos/habits", files: [{ name: "gated-stream.js", data }] }), gatedModel);
      await tab.evaluate(() => window.__host.command("user:on", { app: "demos/habits", id: "gated-stream" }));
      await tab.evaluate(([code, html]) => window.__host.command("user:add", { app: "demos/habits", files: [{ name: "ask-the-page.js", data: code }, { name: "ask-the-page.html", data: html }] }), [askCode, askHtml]);
      await tab.evaluate(() => window.__host.command("user:on", { app: "demos/habits", id: "ask-the-page" }));
      await tab.evaluate(([code, html]) => window.__host.command("user:add", { app: "demos/habits", files: [{ name: "chat.js", data: code }, { name: "chat.html", data: html }] }), [chatCode, chatHtml]);
      await tab.evaluate(() => window.__host.command("user:on", { app: "demos/habits", id: "chat" }));

      const askSel = '[data-key^="ask-the-page@"]';
      await tab.waitForSelector(`${askSel} option[value="gated-stream"]`, { state: "attached", timeout: 10000 });
      await tab.selectOption(`${askSel} select`, "gated-stream");
      await tab.fill(`${askSel} input[name="question"]`, "Stream this");
      await tab.click(`${askSel} button[type="submit"]`);
      const askMid = await tab.waitForSelector(`${askSel} .answer >> text=First part…`, { timeout: 6000 }).then(() => tab.textContent(`${askSel} .answer`), () => "");
      // Trigger release via plugins:changed or let it finish.
      await tab.evaluate(() => window.__host.command("user:off", { app: "demos/habits", id: "nonexistent" })).catch(() => {});
      const askEnd = await tab.waitForSelector(`${askSel} .answer >> text=First part… second part!`, { timeout: 6000 }).then(() => true, () => false);
      check("Ask the page renders live streaming chunks before the stream finishes", askMid.includes("First part…") && !askMid.includes("second part!") && askEnd, askMid);

      const chatSel = '[data-key^="chat@"]';
      await tab.waitForSelector(`${chatSel} input[name="text"]`, { timeout: 10000 });
      await tab.fill(`${chatSel} input[name="text"]`, "Hello direct stream");
      await tab.click(`${chatSel} button[type="submit"]`);
      const chatMid = await tab.waitForSelector(`${chatSel} li >> text=First part…`, { timeout: 6000 }).then(() => tab.textContent(`${chatSel} ol li:last-child`), () => "");
      const chatEnd = await tab.waitForSelector(`${chatSel} li >> text=First part… second part!`, { timeout: 6000 }).then(() => true, () => false);
      check("Chat streams live text updates when asking the language model directly", chatMid.includes("First part…") && !chatMid.includes("second part!") && chatEnd, chatMid);
    } finally {
      for (const id of ["chat", "ask-the-page", "gated-stream"]) {
        await tab.evaluate((id) => window.__host.command("user:remove", { app: "demos/habits", id }), id).catch(() => {});
      }
      await tab.close({ runBeforeUnload: true });
    }
  } finally {
    for (const id of ids) await a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
    for (const name of ["anthropic", "openai", "gemini"]) {
      await plugin(`export const manifest = { id: 'clean-${name}', name: 'Clean', permissions: ['secret:${name}'] };
export default async (ctx) => { await ctx.call('secrets', 'forget', '${name}'); };`).catch(() => {});
      await a.evaluate((id) => window.__host.command("uninstall", id), `clean-${name}`).catch(() => {});
    }
    server.close();
  }
}
