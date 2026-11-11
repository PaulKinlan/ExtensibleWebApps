// The browser's own on-device language model (such as Gemini Nano through the
// Prompt API), behind the platform's `llm` service. Runs locally on the
// person's device with no API key and no network permission:
//
//   <link rel="plugin" href="/std/llm/browser.js">
//
// It reports `ready: true` only when the browser's `LanguageModel` (or legacy
// `self.ai?.languageModel`) is already available (`"available"` or `"readily"`),
// so linking it alongside cloud providers never hijacks requests in browsers
// where no on-device model is installed.

export const manifest = {
  id: "llm-browser",
  name: "Browser AI (On-device)",
  description: "A language model built into supported browsers through the Prompt API. Runs on your device with no API key and no network.",
  version: "1.0.0",
  permissions: ["provide:llm"],
  services: ["llm"],
};

const MODEL_ID = "browser";
const CHUNK = "chunk";

/** Returns `{ lm, legacy }` if the Prompt API exists in this worker, or null. */
function detect() {
  if (typeof globalThis.LanguageModel === "object" || typeof globalThis.LanguageModel === "function") {
    return { lm: globalThis.LanguageModel, legacy: false };
  }
  const legacyLm = typeof self !== "undefined" ? self.ai?.languageModel : undefined;
  if (legacyLm && (typeof legacyLm === "object" || typeof legacyLm === "function")) {
    return { lm: legacyLm, legacy: true };
  }
  return null;
}

/** Reads the model's availability state without triggering a download. */
async function availability(entry = detect()) {
  if (!entry) return "unavailable";
  const { lm } = entry;
  try {
    if (typeof lm.availability === "function") {
      const state = await lm.availability();
      return typeof state === "string" ? state : "unavailable";
    }
    if (typeof lm.capabilities === "function") {
      const caps = await lm.capabilities();
      return typeof caps?.available === "string" ? caps.available : "unavailable";
    }
  } catch {
    return "unavailable";
  }
  return "unavailable";
}

const isReady = (state) => state === "available" || state === "readily";

function base64ToBlob(base64, mediaType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mediaType });
}

function toPromptContent(content) {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((p) => {
    if (p.type === "text") return { type: "text", value: p.text };
    return { type: p.type, value: base64ToBlob(p.data, p.mediaType) };
  });
}

function historyMessage(m) {
  if (m.role === "tool") return { role: "user", content: `Tool ${m.name} (${m.id}): ${m.content}` };
  if (m.role === "assistant") return { role: "assistant", content: String(m.content ?? "") };
  return { role: "user", content: toPromptContent(m.content) };
}

function prepareSessionOptions(request) {
  const initialPrompts = [];
  if (request.system) initialPrompts.push({ role: "system", content: request.system });
  for (const m of request.messages.slice(0, -1)) initialPrompts.push(historyMessage(m));

  let hasImage = false;
  let hasAudio = false;
  for (const m of request.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p.type === "image") hasImage = true;
      if (p.type === "audio") hasAudio = true;
    }
  }
  const options = {};
  if (initialPrompts.length) options.initialPrompts = initialPrompts;
  if (hasImage || hasAudio) {
    options.expectedInputs = [{ type: "text" }, ...(hasImage ? [{ type: "image" }] : []), ...(hasAudio ? [{ type: "audio" }] : [])];
  }
  return options;
}

function preparePromptInput(last) {
  if (last.role === "user" && !Array.isArray(last.content)) return String(last.content ?? "");
  if (last.role === "tool") return `Tool ${last.name} (${last.id}): ${last.content}`;
  return [historyMessage(last)];
}

async function* readChunks(stream) {
  if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream) yield String(chunk);
    return;
  }
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield String(value);
    }
  }
}

export default function (ctx) {
  ctx.on("llm:providers", async (value) => {
    const state = await availability();
    return {
      providers: [
        ...value.providers,
        { id: manifest.id, name: manifest.name, model: MODEL_ID, ready: isReady(state) },
      ],
    };
  });

  ctx.on("llm:models", async ({ provider }) => {
    if (provider !== manifest.id) return undefined;
    const state = await availability();
    if (state === "unavailable" || state === "no") {
      return { error: "This browser has no on-device language model available", declined: true };
    }
    return {
      models: [{ id: MODEL_ID, name: manifest.name }],
      tiers: { best: MODEL_ID, balanced: MODEL_ID, fast: MODEL_ID },
    };
  });

  async function run(request, streaming) {
    const entry = detect();
    const state = await availability(entry);
    if (!entry || state === "unavailable" || state === "no") {
      return { error: "This browser has no on-device language model available", declined: true };
    }
    let session;
    try {
      session = await entry.lm.create(prepareSessionOptions(request));
      const input = preparePromptInput(request.messages.at(-1));
      const promptOptions = request.schema ? { responseConstraint: request.schema } : undefined;
      let text = "";

      if (streaming && typeof session.promptStreaming === "function") {
        let sentCount = 0;
        let buffered = "";
        let lastFlush = 0;
        const stream = promptOptions ? session.promptStreaming(input, promptOptions) : session.promptStreaming(input);
        for await (const rawChunk of readChunks(stream)) {
          let delta = rawChunk;
          if (entry.legacy && text && rawChunk.startsWith(text)) {
            delta = rawChunk.slice(text.length);
            text = rawChunk;
          } else {
            text += rawChunk;
          }
          if (!delta || !request.streamId) continue;
          if (sentCount < 64) {
            sentCount++;
            await ctx.call("llm", CHUNK, request.streamId, delta);
            lastFlush = Date.now();
          } else {
            buffered += delta;
            if (Date.now() - lastFlush >= 20) {
              await ctx.call("llm", CHUNK, request.streamId, buffered);
              buffered = "";
              lastFlush = Date.now();
            }
          }
        }
        if (buffered && request.streamId) await ctx.call("llm", CHUNK, request.streamId, buffered);
      } else {
        const result = promptOptions ? await session.prompt(input, promptOptions) : await session.prompt(input);
        text = String(result ?? "");
        if (streaming && text && request.streamId) await ctx.call("llm", CHUNK, request.streamId, text);
      }

      const inputUsage = Number(session.contextUsage ?? session.tokensSoFar) || 0;
      const answer = {
        text,
        toolCalls: [],
        stop: "end",
        usage: { input: inputUsage, output: Math.ceil(text.length / 4) },
        model: MODEL_ID,
      };
      if (request.schema) answer.json = JSON.parse(text);
      return answer;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      try {
        session?.destroy?.();
      } catch {}
    }
  }

  ctx.on("llm:complete", async (request) => {
    if (request.provider !== manifest.id) return undefined;
    return run(request, false);
  });

  ctx.on("llm:stream", async (request) => {
    if (request.provider !== manifest.id) return undefined;
    return run(request, true);
  });
}
