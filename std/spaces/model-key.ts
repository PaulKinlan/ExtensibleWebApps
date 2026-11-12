// A model key the space holds for its members, on the space's server. The
// space's owner gives one key for one vendor; members then ask that vendor's
// model through the space, and need no key of their own.
//
// The key never goes to a browser. It is kept in the space's folder only
// encrypted (AES-GCM), and what unlocks it is not in the space at all: the
// host keeps a lock for each space with its accounts and hands it in with
// each request (src/server/space-model.ts). So the space's folder, a copy of
// it, a plugin that reads files, or a member's debugger never holds a key
// that can be read. It is unlocked here, in memory, for the one request to
// the vendor, which is the only place it is sent.
//
// The vendors are the site's own model plugins (std/llm/anthropic.js,
// openai.js, gemini.js), run here as they are: the same translation a
// browser uses with a person's own key. Each is handed the few calls it
// makes (`net.fetch`, `secrets`, its settings), and its requests go only to
// the host its manifest names, with the key put in where it writes
// `{ secret }`, as the kernel does for a plugin (src/kernel/net.ts).
//
// Only the host can reach this, through the `model` door (std/spaces/module.ts):
// it has checked who is asking, and says which member it is.
//
// Loaded the first time the door is used.

import type { RouteRequest, RouteResponse } from "../../src/kernel/routes";
import type { Store } from "../../src/kernel/store";
import { record } from "../../src/kernel/trace";
import { checkRequest } from "../llm/module";
import anthropic, { manifest as anthropicManifest } from "../llm/anthropic.js";
import gemini, { manifest as geminiManifest } from "../llm/gemini.js";
import openai, { manifest as openaiManifest } from "../llm/openai.js";

/** The encrypted key and who gave it. */
const FILE = "model-key.json";
/** What members asked today, to hold each to the daily limit and to show the owner. */
const USE = "model-use.json";
/** How many questions one member may ask on the space's key in a day. */
export const DAILY = 200;
const TIMEOUT = 5 * 60_000;
const MAX_ANSWER = 4_000_000;

type Plugin = { manifest: { id: string; name: string; permissions: string[] }; start: (ctx: unknown) => void };
/** The vendors a space can hold a key for, by the name its owner picks. */
const VENDORS: Record<string, Plugin & { label: string }> = {
  anthropic: { manifest: anthropicManifest, start: anthropic, label: "Claude" },
  gemini: { manifest: geminiManifest, start: gemini, label: "Gemini" },
  openai: { manifest: openaiManifest, start: openai, label: "OpenAI" },
};

interface Kept {
  vendor: string;
  iv: string;
  data: string;
  by: string;
  byName: string;
  at: string;
  /** The vendor refused the key: it stays, for its owner to see why members get no answer, until a new one is given. */
  refused?: boolean;
}
type Use = { day: string; members: Record<string, { name: string; asked: number; input: number; output: number }> };

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const lockOf = (lock: string) => crypto.subtle.importKey("raw", unb64(lock.replace(/-/g, "+").replace(/_/g, "/")) as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);

async function seal(lock: string, key: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await lockOf(lock), new TextEncoder().encode(key)));
  return { iv: b64(iv), data: b64(data) };
}
async function unseal(lock: string, kept: Kept): Promise<string> {
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(kept.iv) as BufferSource }, await lockOf(lock), unb64(kept.data) as BufferSource));
}

/**
 * One vendor's plugin, started with what it asks the kernel for: its hooks, by name. `key` is put into a
 * request only where the plugin writes { secret }, and only for the host its manifest names.
 */
function start(vendor: Plugin, key: string, fetcher: typeof fetch, gateways: Record<string, string>, refused: () => void) {
  const host = vendor.manifest.permissions.find((p) => p.startsWith("network:"))!.slice(8);
  const hooks = new Map<string, (value: any) => unknown>();
  const hide = (text: string) => (key.length >= 4 ? text.split(key).join("[secret]") : text);
  vendor.start({
    on: (name: string, heard: (value: any) => unknown) => void hooks.set(name, heard),
    log() {},
    settings: { get: async () => ({}) },
    async call(service: string, method: string, ...args: any[]) {
      if (service === "secrets") {
        // The vendor refused the key, and its plugin forgets it: here that marks the space's key as refused.
        if (method === "forget") refused();
        return method === "has" ? { set: true, hosts: [host] } : method === "request" ? { set: true } : true;
      }
      if (service !== "net" || method !== "fetch") throw new Error(`A model on a space's server has no ${service}.${method}`);
      const input = args[0] as { url: string; method?: string; headers?: Record<string, unknown>; body?: unknown };
      const url = new URL(input.url);
      if (url.protocol !== "https:" || url.host !== host) throw new Error(`${vendor.manifest.name} may only reach ${host}`);
      const headers = new Headers();
      for (const [name, value] of Object.entries(input.headers ?? {})) {
        if (typeof value === "string") headers.set(name, value);
        else headers.set(name, `${typeof (value as { prefix?: unknown })?.prefix === "string" ? (value as { prefix: string }).prefix : ""}${key}`);
      }
      // A deployment may reach a vendor through a gateway of its own (MODEL_GATEWAYS): the same path, at its address.
      const to = gateways[host] ? new URL(`${gateways[host].replace(/\/$/, "")}${url.pathname}${url.search}`) : url;
      const response = await fetcher(to, { method: input.method ?? "GET", headers, body: input.body === undefined ? undefined : String(input.body), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) }).catch((error) => {
        throw new Error(`Couldn't reach ${host}: ${error instanceof Error ? error.message : error}`);
      });
      // Never followed: the key goes to the vendor's own host and nowhere it points. ("manual", since Cloudflare has no "error".)
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) throw new Error(`${host} sent the request elsewhere, which a space's key doesn't follow`);
      const text = (await response.text()).slice(0, MAX_ANSWER);
      return { ok: response.ok, status: response.status, headers: Object.fromEntries([...response.headers].map(([k, v]) => [k, hide(v)])), text: hide(text) };
    },
  });
  return hooks;
}

const json = (value: unknown, status = 200): RouteResponse => ({ status, json: value });
const today = () => new Date().toISOString().slice(0, 10);

/** Answers the `model` door for one space. */
export function spaceModel(store: Store, fetcher: typeof fetch) {
  /** One change to the key or the count at a time. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };
  const kept = () => store.readJson<Kept | null>(FILE, null);
  const used = async (): Promise<Use> => {
    const use = await store.readJson<Use | null>(USE, null);
    return use?.day === today() && use.members && typeof use.members === "object" ? use : { day: today(), members: {} };
  };
  const what = (k: Kept) => ({ set: true, vendor: k.vendor, model: VENDORS[k.vendor]?.label ?? k.vendor, by: k.by, byName: k.byName, at: k.at, ...(k.refused ? { refused: true } : {}), daily: DAILY });

  return async function answer(request: RouteRequest): Promise<RouteResponse> {
    const form = (request.form ?? {}) as { op?: string; lock?: string; name?: string; owner?: boolean; vendor?: unknown; key?: unknown; request?: unknown; gateways?: Record<string, string> };
    const member = request.member ?? "";
    if (!member || typeof form.lock !== "string") return json({ error: "Only the space's server can ask this" }, 403);
    const name = typeof form.name === "string" && form.name ? form.name : "A member";
    const has = await kept();

    if (form.op === "state") {
      if (!has) return json({ set: false, vendors: Object.entries(VENDORS).map(([id, v]) => ({ id, name: v.label })) });
      const use = await used();
      const mine = use.members[member]?.asked ?? 0;
      return json({
        ...what(has),
        vendors: Object.entries(VENDORS).map(([id, v]) => ({ id, name: v.label })),
        asked: mine,
        // Its owner sees what each member asked today: they are the one paying.
        ...(form.owner ? { today: Object.values(use.members).map(({ name, asked, input, output }) => ({ name, asked, input, output })) } : {}),
      });
    }

    if (form.op === "set" || form.op === "clear") {
      if (!form.owner) return json({ error: "Only the space's owner can give it a model key, or take it away" }, 403);
      if (form.op === "clear") {
        await serial(() => store.removeFile(FILE).catch(() => {}));
        record({ kind: "note", name: "space-model:cleared", detail: name });
        return json({ set: false });
      }
      const vendor = String(form.vendor ?? "");
      if (!Object.hasOwn(VENDORS, vendor)) return json({ error: `Pick whose key it is: ${Object.values(VENDORS).map((v) => v.label).join(", ")}` }, 400);
      const key = typeof form.key === "string" ? form.key.trim() : "";
      if (key.length < 8 || key.length > 400 || /\s/.test(key)) return json({ error: "That doesn't look like an API key: paste the whole key, with no spaces" }, 400);
      const next: Kept = { vendor, ...(await seal(form.lock, key)), by: member, byName: name, at: new Date().toISOString() };
      await serial(() => store.writeJson(FILE, next));
      record({ kind: "note", name: "space-model:set", detail: `${vendor}, by ${name}` });
      return json(what(next));
    }

    if (form.op !== "complete" && form.op !== "models") return json({ error: "Not something a space's model does" }, 400);
    if (!has) return json({ error: "This space has no model key. Its owner can give it one on their account page, or you can add a model of your own from Customize." }, 409);
    const vendor = VENDORS[has.vendor];
    if (!vendor) return json({ error: `This space's key is for ${has.vendor}, which this site no longer has. Ask ${has.byName} to give another on their account page.` }, 409);
    if (has.refused) return json({ error: `${vendor.label} refused the key ${has.byName} gave this space. Ask them to give a new one on their account page, or add a model of your own from Customize.` }, 409);

    let checked: ReturnType<typeof checkRequest> | undefined;
    if (form.op === "complete") {
      try {
        checked = checkRequest(form.request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
      // Counted before it is asked, so many questions at once can't all get past the limit.
      const allowed = await serial(async () => {
        const use = await used();
        const mine = (use.members[member] ??= { name, asked: 0, input: 0, output: 0 });
        if (mine.asked >= DAILY) return false;
        mine.asked++;
        mine.name = name;
        await store.writeJson(USE, use);
        return true;
      });
      if (!allowed) return json({ error: `You've asked ${DAILY} questions on this space's key today, which is the most one member may. It starts again tomorrow, or add a model of your own from Customize.` }, 429);
    }

    let key: string;
    try {
      key = await unseal(form.lock, has);
    } catch {
      return json({ error: `This space's model key can't be unlocked on this server (it was given on another, or the server's lock for the space was lost). Ask ${has.byName} to give it again on their account page.` }, 409);
    }
    let wasRefused = false;
    const hooks = start(vendor, key, fetcher, form.gateways ?? {}, () => (wasRefused = true));
    const started = Date.now();
    const value = (await Promise.resolve(hooks.get(form.op === "complete" ? "llm:complete" : "llm:models")?.(form.op === "complete" ? { ...checked, provider: vendor.manifest.id } : { provider: vendor.manifest.id })).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }))) as Record<string, any> | undefined;
    if (wasRefused) {
      await serial(async () => {
        const now = await kept();
        if (now && now.data === has.data) await store.writeJson(FILE, { ...now, refused: true });
      });
      record({ kind: "error", name: "space-model:refused", detail: has.vendor });
      return json({ error: `${vendor.label} refused the key ${has.byName} gave this space. Ask them to give a new one on their account page, or add a model of your own from Customize.` }, 409);
    }
    if (!value || typeof value.error === "string") return json({ error: `${vendor.label}, on this space's key: ${String(value?.error ?? "no answer").split(key).join("[secret]").slice(0, 2000)}` }, 502);
    if (form.op === "models") return json({ models: value.models ?? [], tiers: value.tiers ?? {} });
    const usage = { input: Number(value.usage?.input) || 0, output: Number(value.usage?.output) || 0 };
    await serial(async () => {
      const use = await used();
      const mine = (use.members[member] ??= { name, asked: 1, input: 0, output: 0 });
      mine.input += usage.input;
      mine.output += usage.output;
      await store.writeJson(USE, use);
    });
    record({ kind: "call", name: "space-model:complete", ms: Date.now() - started, detail: `${has.vendor} ${String(value.model ?? "")}, ${usage.input} in, ${usage.output} out, for ${name}` });
    return json({ answer: value, paidBy: has.byName });
  };
}
