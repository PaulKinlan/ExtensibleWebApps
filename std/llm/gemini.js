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
// Models: the `model` setting, or a request's `model`, is a model's id or a
// tier. A tier is the newest model of that kind in Google's live model list:
// best is Argon (or Pro), balanced is Flash, fast is Flash-Lite.
//
// This file translates between the platform's request and answer
// (std/llm/module.ts) and the Gemini API's generateContent.

export const manifest = {
  id: "llm-gemini",
  name: "Gemini (Google)",
  description: "A language model for this app: Gemini, from Google. Uses your own Gemini API key, which goes only to Google.",
  version: "1.1.0",
  permissions: ["provide:llm", "network:generativelanguage.googleapis.com", "secret:gemini"],
  services: ["llm"],
  settings: {
    model: {
      type: "string",
      title: "Model",
      description: "best, balanced or fast for Google's newest Gemini of that kind, or a model's id such as gemini-4-argon.",
      default: "best",
    },
  },
};

const API = "https://generativelanguage.googleapis.com";
const HOST = "generativelanguage.googleapis.com";
const SECRET = "gemini";

/** Each tier: the model ids it takes, newest by version, and the model to use when the list can't be read. */
const TIERS = {
  best: { pattern: /^gemini-(\d+(?:\.\d+)?)-(?:argon|pro)$/, fallback: "gemini-4-argon" },
  balanced: { pattern: /^gemini-(\d+(?:\.\d+)?)-flash$/, fallback: "gemini-3.8-flash" },
  fast: { pattern: /^gemini-(\d+(?:\.\d+)?)-flash-lite$/, fallback: "gemini-3.5-flash-lite" },
};

/** Compares versions such as 3.8 and 4, part by part. */
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

const KEY = { "x-goog-api-key": { secret: SECRET } };

/** The platform's messages as Gemini's contents. A turn with state goes back as Gemini sent it, thought signatures included. */
function toContents(messages) {
  const out = [];
  const push = (role, part) => {
    const last = out[out.length - 1];
    if (last?.role === role) last.parts.push(part);
    else out.push({ role, parts: [part] });
  };
  for (const m of messages) {
    if (m.role === "tool") push("user", { functionResponse: { name: m.name, response: { content: m.content } } });
    else if (m.role === "assistant" && Array.isArray(m.state)) for (const part of m.state) push("model", part);
    else if (m.role === "assistant") {
      if (m.content) push("model", { text: m.content });
      for (const c of m.toolCalls ?? []) push("model", { functionCall: { name: c.name, args: c.args ?? {} } });
    } else push("user", { text: m.content });
  }
  return out;
}

const STOP = { STOP: "end", MAX_TOKENS: "length", SAFETY: "refused", RECITATION: "refused", PROHIBITED_CONTENT: "refused", BLOCKLIST: "refused" };

export default function (ctx) {
  const setting = async () => (await ctx.settings.get()).model || manifest.settings.model.default;
  const ready = async () => (await ctx.call("secrets", "has", SECRET)).set;
  /** Counts the keys the person has given here, so a late answer about an earlier key can't cost them the one they gave since. */
  let given = 0;
  const ensureKey = async () => {
    if (await ready()) return true;
    const { set } = await ctx.call("secrets", "request", SECRET, { hosts: [HOST], label: "Gemini API key" });
    if (set) given++;
    return set;
  };

  // The live model list, read at most once an hour.
  let listed;

  /**
   * What to say when the vendor answers with an error. A key the vendor refuses is forgotten, so the next
   * request asks for it again: a mis-pasted key would otherwise fail every request with no way to replace it.
   */
  async function failure(response, data, used) {
    if (response.status === 401 || (data.error?.details ?? []).some((d) => d?.reason === "API_KEY_INVALID")) {
      // Another request already had this key refused, and the person has given a new one since: leave that one be.
      if (used !== given) return "Google didn't accept the earlier API key. Ask again to use the one you gave since.";
      listed = undefined;
      const kept = await ctx.call("secrets", "forget", SECRET).then(() => "", (error) => (error instanceof Error ? error.message : String(error)));
      if (kept) return `Google didn't accept that API key, and it couldn't be forgotten (${kept}). Reset this app's data to give another.`;
      return "Google didn't accept that API key, so it has been forgotten. Ask again and paste the key once more.";
    }
    return data.error?.message ?? `HTTP ${response.status}`;
  }
  async function list() {
    if (listed && Date.now() - listed.at < 3_600_000) return listed.models;
    const used = given;
    const response = await ctx.call("net", "fetch", { url: `${API}/v1beta/models?pageSize=1000`, headers: KEY });
    const data = JSON.parse(response.text || "{}");
    if (!response.ok) throw new Error(await failure(response, data, used));
    const models = (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? ["generateContent"]).includes("generateContent"))
      .map((m) => ({ id: String(m.name).replace(/^models\//, ""), name: m.displayName }));
    listed = { at: Date.now(), models };
    return models;
  }
  /** The model a request's model, or the setting, stands for: a tier's newest model, or the id as given. */
  async function resolve(model) {
    const tier = TIERS[model];
    if (!tier) return model;
    // A list that can't be read falls back to the tier's own model, but a refused key ends the request here.
    const ids = await list().then((models) => models.map((m) => m.id), (error) => {
      if (/didn't accept (that|the earlier) API key/.test(String(error?.message))) throw error;
      return [];
    });
    return newest(ids, tier.pattern) ?? tier.fallback;
  }

  ctx.on("llm:providers", async (value) => {
    return { providers: [...value.providers, { id: manifest.id, name: "Gemini", model: await setting(), ready: await ready() }] };
  });

  ctx.on("llm:models", async ({ provider }) => {
    if (provider !== manifest.id) return undefined;
    try {
      if (!(await ensureKey())) return { error: "No Gemini API key was given" };
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
      if (!(await ensureKey())) return { error: "No Gemini API key was given" };
      const model = await resolve(request.model ?? (await setting()));
      const body = { contents: toContents(request.messages) };
      if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
      if (request.tools?.length) body.tools = [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description ?? "", parametersJsonSchema: t.parameters ?? { type: "object", properties: {} } })) }];
      // Gemini 4 caps a non-streaming answer at 32K tokens.
      const config = { maxOutputTokens: Math.min(request.maxTokens ?? 16000, 32000) };
      if (request.schema) Object.assign(config, { responseMimeType: "application/json", responseJsonSchema: request.schema });
      body.generationConfig = config;
      const used = given;
      const response = await ctx.call("net", "fetch", {
        url: `${API}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: "POST",
        headers: { ...KEY, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = JSON.parse(response.text || "{}");
      if (!response.ok) return { error: await failure(response, data, used) };
      const candidate = data.candidates?.[0];
      if (!candidate) return { text: "", stop: "refused", model, usage: { input: data.usageMetadata?.promptTokenCount ?? 0, output: 0 } };
      const parts = candidate.content?.parts ?? [];
      // A call may have no id; its answer goes back by name, so any id will do.
      const toolCalls = parts.filter((p) => p.functionCall).map((p, i) => ({ id: p.functionCall.id ?? `call-${i + 1}`, name: p.functionCall.name, args: p.functionCall.args ?? {} }));
      const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
      const answer = {
        text,
        toolCalls,
        stop: toolCalls.length ? "tool" : (STOP[candidate.finishReason] ?? "end"),
        usage: { input: data.usageMetadata?.promptTokenCount ?? 0, output: data.usageMetadata?.candidatesTokenCount ?? 0 },
        model: data.modelVersion ?? model,
        // Gemini's turn as sent: its thought signatures have to go back with a tool call's answer.
        state: parts,
      };
      if (request.schema && answer.stop === "end") answer.json = JSON.parse(text);
      return answer;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
