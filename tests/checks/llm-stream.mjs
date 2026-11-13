// Streaming (`llm.stream`, `llm:stream`, `llm:chunk`), multimodal user messages,
// fallback from `llm:stream` to `llm:complete`, and live streaming updates in
// `std/ask-the-page.js` and `std/agents/chat.js`.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { watchErrors } from "../page-errors.mjs";

const MODELS = {
  anthropic: { data: [{ id: "claude-opus-6" }] },
  openai: { data: [{ id: "gpt-6.2-astra" }] },
  compatible: { data: [{ id: "llama3.2" }] },
  gemini: { models: [{ name: "models/gemini-4-argon", supportedGenerationMethods: ["generateContent"] }] },
};

function sseParts(vendor, body, url) {
  if (vendor === "anthropic") {
    const first = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: body.model, usage: { input_tokens: 8, output_tokens: 0 } } })}`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Claude " } })}`,
    ];
    const second = [
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streams!" } })}`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })}`,
    ];
    return [`${first.join("\n\n")}\n\n`, `${second.join("\n\n")}\n\n`];
  }
  if (vendor === "openai") {
    const completed = {
      model: body.model,
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OpenAI streams!" }] }],
      usage: { input_tokens: 9, output_tokens: 4 },
    };
    const first = [`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "OpenAI " })}`];
    const second = [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "streams!" })}`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}`,
    ];
    return [`${first.join("\n\n")}\n\n`, `${second.join("\n\n")}\n\n`];
  }
  if (vendor === "compatible") {
    const first = [`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: "Ollama " }, finish_reason: null }] })}`];
    const second = [
      `data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: "streams!" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 4 } })}`,
      "data: [DONE]",
    ];
    return [`${first.join("\n\n")}\n\n`, `${second.join("\n\n")}\n\n`];
  }
  const model = decodeURIComponent(url.split("/models/")[1].split(":")[0]);
  const first = [`data: ${JSON.stringify({ modelVersion: model, candidates: [{ content: { role: "model", parts: [{ text: "Gemini " }] } }] })}`];
  const second = [`data: ${JSON.stringify({ modelVersion: model, candidates: [{ content: { role: "model", parts: [{ text: "streams!" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 4 } })}`];
  return [`${first.join("\n\n")}\n\n`, `${second.join("\n\n")}\n\n`];
}

function sseResponse(vendor, body, url) {
  const [first, second] = sseParts(vendor, body, url);
  return first + second;
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

export default async function ({ a, check, openTab, URL: siteUrl, plugin, pluginLog, context, errors }) {
  const received = [];
  const heldStreams = [];
  const server = createServer((req, res) => {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    if (req.url === "/release-held") {
      const count = heldStreams.length;
      while (heldStreams.length) heldStreams.shift()();
      return res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify({ released: count }));
    }
    if (req.url === "/split-secret") {
      req.socket?.setNoDelay(true);
      res.writeHead(200, { ...cors, "Content-Type": "text/plain", "Cache-Control": "no-cache" });
      res.flushHeaders();
      res.write(`${"x".repeat(2048)} echoed: sk-split-`);
      setTimeout(() => {
        res.end("secret-12345 done");
      }, 60);
      return;
    }
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
      if (wantsStream && raw.includes("hold-http-stream")) {
        const [first, second] = sseParts(vendor, body, req.url);
        req.socket?.setNoDelay(true);
        res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.flushHeaders();
        // Pad with an SSE comment so Chromium's network pipe flushes the first chunk immediately before EOF.
        res.write(`: ${" ".repeat(2048)}\n\n${first}`);
        const timer = setTimeout(() => {
          if (!res.writableEnded) res.end(second);
        }, 8000);
        heldStreams.push(() => {
          clearTimeout(timer);
          if (!res.writableEnded) res.end(second);
        });
        return;
      }
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
    "inc-stream-tester",
    "net-eavesdropper",
    "net-redaction-tester",
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

    // 2b. True incremental HTTP SSE streaming: deltas arrive BEFORE the HTTP response closes across all 4 providers.
    await plugin(`export const manifest = { id: 'inc-stream-tester', name: 'Incremental stream tester', permissions: ['llm', 'network:${local}'] };
export default async (ctx) => {
  const results = {};
  for (const p of ['llm-anthropic', 'llm-openai', 'llm-openai-compatible', 'llm-gemini']) {
    const sid = 'inc-' + p;
    const seen = [];
    let resolved = false;
    let sawFirstBeforeClose = false;
    let markFirst;
    const firstArrived = new Promise((r) => { markFirst = r; });
    const off = ctx.on('llm:chunk', ({ streamId, delta, done }) => {
      if (streamId !== sid) return;
      seen.push({ delta, done, whileOpen: !resolved });
      if (!done && delta && !sawFirstBeforeClose) {
        sawFirstBeforeClose = !resolved;
        markFirst();
      }
    });
    const pending = ctx.call('llm', 'stream', { provider: p, streamId: sid, messages: [{ role: 'user', content: 'hold-http-stream' }] }).then((ans) => {
      resolved = true;
      return ans;
    });
    await Promise.race([firstArrived, new Promise((r) => setTimeout(r, 4000))]);
    await ctx.call('net', 'fetch', { url: 'http://${local}/release-held' });
    const ans = await pending;
    off();
    results[p] = { sawFirstBeforeClose, text: ans.text, seen };
  }
  ctx.log('inc-results ' + JSON.stringify(results));
};`);
    const incRaw = await pluginLog("inc-stream-tester", "inc-results ");
    const incResults = JSON.parse(incRaw.slice("inc-results ".length) || "{}");
    for (const [id, firstDelta, fullText] of [
      ["llm-anthropic", "Claude ", "Claude streams!"],
      ["llm-openai", "OpenAI ", "OpenAI streams!"],
      ["llm-openai-compatible", "Ollama ", "Ollama streams!"],
      ["llm-gemini", "Gemini ", "Gemini streams!"],
    ]) {
      const r = incResults[id];
      check(
        `${id} emits incremental SSE deltas via net:chunk before the HTTP stream closes`,
        r?.sawFirstBeforeClose === true && r?.seen?.[0]?.delta === firstDelta && r?.seen?.[0]?.whileOpen === true && r?.text === fullText && r?.seen?.at(-1)?.done === true,
        JSON.stringify(r),
      );
    }

    // 2c. net.fetch streaming: cross-chunk overlap [secret] redaction + caller-only emitTo isolation.
    await plugin(`export const manifest = { id: 'seed-split-sec', name: 'Seed split', permissions: ['secret:split-sec'] };
export default async (ctx) => { await ctx.call('secrets', 'request', 'split-sec', { hosts: ['${local}'], label: 'split-sec' }); };`);
    const splitField = await a.waitForSelector('[data-key^="secrets:"] input[type=password]', { timeout: 8000 }).catch(() => null);
    await splitField?.fill("sk-split-secret-12345");
    await splitField?.press("Tab");
    await a.click('[data-key^="secrets:"] button:has-text("Save")').catch(() => {});
    await a.waitForSelector('[data-key^="secrets:"]', { state: "detached", timeout: 5000 }).catch(() => {});
    await a.evaluate(() => window.__host.command("uninstall", "seed-split-sec")).catch(() => {});

    await plugin(`export const manifest = { id: 'net-eavesdropper', name: 'Net eavesdropper', permissions: ['network:${local}'] };
export default (ctx) => {
  let heard = 0;
  ctx.on('net:chunk', () => { heard++; ctx.log('eavesdropped ' + heard); });
  ctx.log('eavesdropper-ready');
};`);
    await pluginLog("net-eavesdropper", "eavesdropper-ready");

    await plugin(`export const manifest = { id: 'net-redaction-tester', name: 'Net redaction tester', permissions: ['network:${local}', 'secret:split-sec'] };
export default async (ctx) => {
  const chunks = [];
  let finishedFetch = false;
  let firstChunkWhileOpen = false;
  ctx.on('net:chunk', ({ streamId, chunk, done }) => {
    if (streamId !== 'red-1') return;
    if (!done && chunk && !finishedFetch) firstChunkWhileOpen = true;
    chunks.push({ chunk, done });
  });
  const res = await ctx.call('net', 'fetch', {
    url: 'http://${local}/split-secret',
    headers: { authorization: { secret: 'split-sec', prefix: 'Bearer ' } },
    streamId: 'red-1',
  });
  finishedFetch = true;
  const joined = chunks.filter((c) => !c.done).map((c) => c.chunk).join('');
  const leaked = chunks.some((c) => c.chunk.includes('sk-split') || c.chunk.includes('secret-12345'));
  ctx.log('net-redact ' + JSON.stringify({ firstChunkWhileOpen, leaked, tail: joined.slice(2048), textTail: res.text.slice(2048), done: chunks.at(-1)?.done }));
};`);
    const redactLog = JSON.parse((await pluginLog("net-redaction-tester", "net-redact ")).slice("net-redact ".length) || "{}");
    const eavesdropped = await a.evaluate(() => window.__host.traces.some((e) => e.plugin === "net-eavesdropper" && e.detail?.startsWith("eavesdropped")));
    check(
      "net.fetch streams chunks incrementally, redacts secrets split across TCP chunk boundaries, and delivers net:chunk only to the caller",
      redactLog.firstChunkWhileOpen === true &&
        redactLog.leaked === false &&
        redactLog.tail === " echoed: [secret] done" &&
        redactLog.textTail === " echoed: [secret] done" &&
        redactLog.done === true &&
        !eavesdropped,
      JSON.stringify({ redactLog, eavesdropped }),
    );

    // 3. Live UI streaming updates in std/ask-the-page.js and std/agents/chat.js (direct mode), plus multi-tab isolation.
    const tab = await openTab(`${siteUrl}demos/habits/app.html`);
    let tab2;
    try {
      const gatedModel = `export const manifest = { id: "gated-stream", name: "Gated stream", permissions: ["provide:llm"], services: ["llm"] };
export default (ctx) => {
  const releases = new Map();
  ctx.on("llm:providers", (v) => ({ providers: [...v.providers, { id: "gated-stream", name: "Gated stream", ready: true }] }));
  ctx.on("llm:stream", async (req) => {
    if (req.provider !== "gated-stream") return;
    const prompt = String(req.messages.at(-1)?.content ?? "");
    if (prompt.startsWith("tab1-fast")) {
      await ctx.call("llm", "chunk", req.streamId, "Tab1 fast reply!");
      return { text: "Tab1 fast reply!", stop: "end", model: "gated-1", usage: { input: 2, output: 3 } };
    }
    if (prompt.startsWith("tab2-slow")) {
      await ctx.call("llm", "chunk", req.streamId, "Tab2 part 1… ");
      await new Promise((r) => { releases.set(req.streamId, r); setTimeout(r, 4000); });
      await ctx.call("llm", "chunk", req.streamId, "Tab2 part 2!");
      return { text: "Tab2 part 1… Tab2 part 2!", stop: "end", model: "gated-1", usage: { input: 2, output: 4 } };
    }
    await ctx.call("llm", "chunk", req.streamId, "First part… ");
    await new Promise((r) => { releases.set(req.streamId, r); setTimeout(r, 4000); });
    await ctx.call("llm", "chunk", req.streamId, "second part!");
    return { text: "First part… second part!", stop: "end", model: "gated-1", usage: { input: 4, output: 4 } };
  });
  ctx.on("plugins:changed", () => {
    for (const r of releases.values()) r();
    releases.clear();
  });
};`;
      const sameIdProbe = `export const manifest = { id: "same-id-probe", name: "Same id probe", scope: "tab", permissions: ["llm", "ui"] };
export default (ctx) => {
  const chunks = [];
  ctx.on("llm:chunk", ({ streamId, delta, done }) => chunks.push({ streamId, delta, done }));
  ctx.ui.render("main", "probe", '<div><button type="button" data-action="fast">Fast</button><button type="button" data-action="slow">Slow</button><pre class="probe-out"></pre></div>');
  ctx.ui.onEvent(async (action) => {
    chunks.length = 0;
    const ans = await ctx.call("llm", "stream", { provider: "gated-stream", streamId: "identical-id", messages: [{ role: "user", content: action === "fast" ? "tab1-fast" : "tab2-slow" }] });
    ctx.ui.render("main", "probe", ctx.ui.html\`<div><pre class="probe-out">\${JSON.stringify({ text: ans.text, chunks })}</pre></div>\`);
  });
};`;
      const askCode = readFileSync(new URL("../../std/ask-the-page.js", import.meta.url), "utf8");
      const askHtml = readFileSync(new URL("../../std/ask-the-page.html", import.meta.url), "utf8");
      const chatCode = readFileSync(new URL("../../std/agents/chat.js", import.meta.url), "utf8");
      const chatHtml = readFileSync(new URL("../../std/agents/chat.html", import.meta.url), "utf8");

      await tab.evaluate((data) => window.__host.command("user:add", { app: "demos/habits", files: [{ name: "gated-stream.js", data }] }), gatedModel);
      await tab.evaluate(() => window.__host.command("user:on", { app: "demos/habits", id: "gated-stream" }));
      await tab.evaluate((data) => window.__host.command("user:add", { app: "demos/habits", files: [{ name: "same-id-probe.js", data }] }), sameIdProbe);
      await tab.evaluate(() => window.__host.command("user:on", { app: "demos/habits", id: "same-id-probe" }));
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

      // Two open tabs streaming concurrently with the exact same streamId ("identical-id") and via Chat:
      // Tab 1 finishes while Tab 2 is still in flight; neither mixes chunks nor deletes the other's stream.
      tab2 = await openTab(`${siteUrl}demos/habits/app.html`);
      const probeSel = '[data-key^="same-id-probe@"]';
      await tab.waitForSelector(`${probeSel} button[data-action="fast"]`, { timeout: 10000 });
      await tab2.waitForSelector(`${probeSel} button[data-action="slow"]`, { timeout: 10000 });
      await tab2.click(`${probeSel} button[data-action="slow"]`);
      await tab.waitForTimeout(150);
      await tab.click(`${probeSel} button[data-action="fast"]`);
      const tab1Out = JSON.parse(await tab.waitForSelector(`${probeSel} pre.probe-out:not(:empty)`, { timeout: 6000 }).then(() => tab.textContent(`${probeSel} pre.probe-out`), () => "{}"));
      const tab2Out = JSON.parse(await tab2.waitForSelector(`${probeSel} pre.probe-out:not(:empty)`, { timeout: 8000 }).then(() => tab2.textContent(`${probeSel} pre.probe-out`), () => "{}"));
      const tab1Deltas = (tab1Out.chunks ?? []).filter((c) => !c.done).map((c) => c.delta);
      const tab2Deltas = (tab2Out.chunks ?? []).filter((c) => !c.done).map((c) => c.delta);
      check(
        "two open tabs calling llm.stream concurrently with the same streamId never mix llm:chunk events or delete each other's active stream",
        JSON.stringify(tab1Deltas) === JSON.stringify(["Tab1 fast reply!"]) &&
          JSON.stringify(tab2Deltas) === JSON.stringify(["Tab2 part 1… ", "Tab2 part 2!"]) &&
          tab1Out.chunks?.at(-1)?.done === true &&
          tab2Out.chunks?.at(-1)?.done === true,
        JSON.stringify({ tab1Out, tab2Out }),
      );
    } finally {
      for (const id of ["chat", "ask-the-page", "same-id-probe", "gated-stream"]) {
        await tab.evaluate((id) => window.__host.command("user:remove", { app: "demos/habits", id }), id).catch(() => {});
      }
      await tab2?.close({ runBeforeUnload: true }).catch(() => {});
      await tab.close({ runBeforeUnload: true });
    }

    // 4. Agent mediation guard: an agent's custom runner cannot call llm.stream directly to bypass agents.complete budgets.
    if (context) {
      const own = await context.browser().newContext({ serviceWorkers: "block" });
      try {
        await own.route(`${siteUrl}demos/librarian/librarian.agent.md`, async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, body: (await response.text()).replace("\nid: librarian\n", "\nid: librarian\nrunner: ./sneaky-stream-loop.js\n") });
        });
        await own.route(`${siteUrl}demos/librarian/sneaky-stream-loop.js`, (route) =>
          route.fulfill({
            contentType: "text/javascript",
            body: `export default async function (ctx) {
  const res = await ctx.call("llm", "stream", { messages: [{ role: "user", content: "hi" }] }).then(() => "allowed", (e) => "refused: " + e.message);
  ctx.log("sneaky-stream " + res);
}`,
          }),
        );
        const bench = await own.newPage();
        await bench.goto(`${siteUrl}workbench/`);
        const page = await own.newPage();
        if (errors) watchErrors(page, errors, "llm-stream-agent-guard");
        await page.goto(`${siteUrl}demos/librarian/app.html`);
        const sneakyStream = await bench
          .waitForFunction(() => window.__host?.traces.find((e) => e.plugin === "librarian" && e.detail?.startsWith("sneaky-stream "))?.detail, null, { timeout: 10000 })
          .then((h) => h.jsonValue(), () => "");
        check(
          "an agent's runner calling llm.stream directly is refused so run and token budgets hold",
          sneakyStream.includes("refused: An agent calls llm.stream through the agents service (agents.complete)"),
          sneakyStream,
        );
      } finally {
        await own.close();
      }
    }
  } finally {
    for (const id of ids) await a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
    for (const name of ["anthropic", "openai", "gemini", "split-sec"]) {
      await plugin(`export const manifest = { id: 'clean-${name}', name: 'Clean', permissions: ['secret:${name}'] };
export default async (ctx) => { await ctx.call('secrets', 'forget', '${name}'); ctx.log('cleaned-${name}'); };`).catch(() => {});
      await pluginLog(`clean-${name}`, `cleaned-${name}`).catch(() => {});
      await a.evaluate((id) => window.__host.command("uninstall", id), `clean-${name}`).catch(() => {});
    }
    server.close();
  }
}
