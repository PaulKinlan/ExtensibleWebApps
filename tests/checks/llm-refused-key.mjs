// A key the vendor refuses (std/llm/anthropic.js, openai.js, gemini.js): a
// person who pastes the wrong key must be asked again, not left with a
// provider that fails every request. Each provider forgets a refused key and
// says so, and its next request shows the key card again. A small server on
// this computer stands in for the three vendors, answering a wrong key the
// way each really does (found with a real Gemini key: tests/real-model/).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = 4178;
const LOCAL = `localhost:${PORT}`;
const RIGHT = "right-key";

/** Each vendor's own answer to a key it doesn't know. */
const REFUSAL = {
  anthropic: [401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }],
  openai: [401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }],
  // Google answers 400, not 401, and names the reason in the details.
  gemini: [400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }] } }],
};
const LISTS = { anthropic: { data: [{ id: "claude-opus-6" }] }, openai: { data: [{ id: "gpt-6-astra" }] }, gemini: { models: [{ name: "models/gemini-4-argon", supportedGenerationMethods: ["generateContent"] }] } };
const ANSWER = {
  anthropic: (body) => ({ model: body.model, content: [{ type: "text", text: "anthropic answered" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
  openai: (body) => ({ model: body.model, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "openai answered" }] }], usage: { input_tokens: 1, output_tokens: 1 } }),
  gemini: () => ({ modelVersion: "gemini-4-argon", candidates: [{ content: { role: "model", parts: [{ text: "gemini answered" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
};

function vendorSource(file, api, host) {
  return readFileSync(new URL(`../../std/llm/${file}`, import.meta.url), "utf8").replaceAll(api, `http://${LOCAL}${new URL(api).pathname.replace(/\/$/, "")}`).replaceAll(host, LOCAL);
}

export default async function ({ a, check, plugin, pluginLog }) {
  const server = createServer((req, res) => {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const h = req.headers;
      const vendor = req.url.startsWith("/v1beta") ? "gemini" : h["x-api-key"] ? "anthropic" : "openai";
      const key = vendor === "gemini" ? h["x-goog-api-key"] : vendor === "anthropic" ? h["x-api-key"] : String(h.authorization ?? "").replace(/^Bearer /, "");
      const [status, data] = key !== RIGHT ? REFUSAL[vendor] : req.method === "GET" ? [200, LISTS[vendor]] : [200, ANSWER[vendor](JSON.parse(raw || "{}"))];
      // A request that says "slow" is answered late, to stand in for a refusal that arrives after the person has given a new key.
      setTimeout(() => res.writeHead(status, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(data)), raw.includes("slow") ? 3000 : 0);
    });
  });
  await new Promise((resolve) => server.listen(PORT, "localhost", resolve));
  const providers = ["llm-anthropic", "llm-openai", "llm-gemini"];
  try {
    await plugin(vendorSource("anthropic.js", "https://api.anthropic.com", "api.anthropic.com"));
    await plugin(vendorSource("openai.js", "https://api.openai.com/v1", "api.openai.com"));
    await plugin(vendorSource("gemini.js", "https://generativelanguage.googleapis.com", "generativelanguage.googleapis.com"));
    // Starts with no keys, whatever an earlier check left, then asks each provider twice.
    await plugin(`export const manifest = { id: 'rekeyer', name: 'Rekeyer', permissions: ['llm', 'secret:anthropic', 'secret:openai', 'secret:gemini'] };
export default async (ctx) => {
  for (const name of ['anthropic', 'openai', 'gemini']) await ctx.call('secrets', 'forget', name);
  const ask = (provider) => ctx.call('llm', 'complete', { provider, messages: [{ role: 'user', content: 'hello' }] }).then((r) => 'answered ' + r.text, (e) => 'failed ' + e.message);
  for (const provider of ${JSON.stringify(providers)}) {
    const name = provider.slice(4);
    ctx.log('rekeyer-first ' + provider + ' ' + await ask(provider));
    ctx.log('rekeyer-kept ' + provider + ' ' + JSON.stringify((await ctx.call('secrets', 'has', name)).set));
    ctx.log('rekeyer-second ' + provider + ' ' + await ask(provider));
    // Leave no key behind: the next check gives these providers keys for its own server.
    await ctx.call('secrets', 'forget', name);
    ctx.log('rekeyer-cleared ' + provider);
  }
};`);
    const paste = async (key) => {
      const field = await a.waitForSelector('[data-key^="secrets:"] input[type=password]', { timeout: 10000 }).catch(() => null);
      await field?.fill(key);
      await field?.press("Tab");
      await a.click('[data-key^="secrets:"] button:has-text("Save")').catch(() => {});
      await a.waitForSelector('[data-key^="secrets:"]', { state: "detached", timeout: 5000 }).catch(() => {});
      return !!field;
    };
    for (const provider of providers) {
      const name = provider.slice(4);
      await paste("wrong-key");
      const first = await pluginLog("rekeyer", `rekeyer-first ${provider}`).catch(() => "");
      check(`${provider}: a key the vendor refuses fails the request with words a person can act on`, /didn't accept that API key, so it has been forgotten/.test(first) && !first.includes("wrong-key"), first);
      check(`${provider}: the refused key is forgotten`, (await pluginLog("rekeyer", `rekeyer-kept ${provider}`).catch(() => "")).endsWith("false"));
      const asked = await paste(RIGHT);
      const second = await pluginLog("rekeyer", `rekeyer-second ${provider}`).catch(() => "");
      check(`${provider}: the next request asks for the key again, and the right one works`, asked && second.endsWith(`answered ${name} answered`), second);
      await pluginLog("rekeyer", `rekeyer-cleared ${provider}`).catch(() => {});
    }

    // Two requests share a wrong key. The first refusal forgets it and the person gives the right one; the second
    // refusal, arriving late, is about the old key and must not cost them the new one.
    await plugin(`export const manifest = { id: 'racer', name: 'Racer', permissions: ['llm', 'secret:gemini'] };
export default async (ctx) => {
  // The model id is given, so no model list is read: each ask is one request.
  const ask = (content) => ctx.call('llm', 'complete', { provider: 'llm-gemini', model: 'gemini-4-argon', messages: [{ role: 'user', content }] }).then((r) => 'answered ' + r.text, (e) => 'failed ' + e.message);
  const slow = ask('slow');
  while (!(await ctx.call('secrets', 'has', 'gemini')).set) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  ctx.log('racer-quick ' + await ask('quick'));
  ctx.log('racer-again ' + await ask('again'));
  ctx.log('racer-slow ' + await slow);
  ctx.log('racer-after ' + await ask('after') + ' ' + JSON.stringify((await ctx.call('secrets', 'has', 'gemini')).set));
  await ctx.call('secrets', 'forget', 'gemini');
  ctx.log('racer-cleared');
};`);
    const late = (prefix) => a.waitForFunction((p) => window.__host.traces.findLast((e) => e.plugin === "racer" && e.detail?.startsWith(p)), prefix, { timeout: 15000 }).then((h) => h.jsonValue()).then((e) => e.detail, () => "");
    await paste("wrong-key");
    const quick = await late("racer-quick");
    await paste(RIGHT);
    const again = await late("racer-again");
    const slow = await late("racer-slow");
    const after = await late("racer-after");
    check("a refusal that arrives after the person gave a new key doesn't forget the new key", /forgotten/.test(quick) && again.endsWith("answered gemini answered") && /didn't accept the earlier API key/.test(slow) && after.endsWith("answered gemini answered true"), [quick, again, slow, after].join(" | "));
    await late("racer-cleared");
  } finally {
    for (const id of ["racer", "rekeyer", ...providers]) await a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
    server.close();
  }
}
