// A model key a space holds for its members (src/server/space-model.ts,
// std/spaces/model-key.ts), the same on every host: only the owner gives or
// takes the key, a member with no key of their own gets an answer through it,
// and the key is in nothing a browser is sent and in nothing the server keeps.
//
// The vendor is a stand-in with the shape of Anthropic's API, which both hosts
// reach through MODEL_GATEWAYS: it keeps every key it was sent.

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

/** The key the owner gives. Nothing but the vendor should ever hold it. */
export const KEY = "sk-space-0123456789abcdefghijKLMNOP";
/** A key the vendor refuses. */
const BAD = "sk-refused-0123456789abcdefghijKLMN";

/**
 * A vendor with the shape of Anthropic's API. `keys` is every key it was sent, `asked` every question.
 * `script`, when a check sets it, answers a request in the vendor's place (tests/server/acp.mjs has it ask
 * for tools): it is given the request's body, and what it returns is the answer; undefined leaves it to the vendor.
 */
export async function fakeModel() {
  const keys = [];
  const asked = [];
  const out = { script: undefined };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const key = String(req.headers["x-api-key"] ?? "");
    keys.push(key);
    const send = (status, body) => res.writeHead(status, { "content-type": "application/json", "x-echo": key }).end(JSON.stringify(body));
    if (key !== KEY) return send(401, { error: { message: "invalid x-api-key" } });
    if (req.url?.startsWith("/v1/models")) return send(200, { data: [{ id: "claude-test-1", display_name: "Claude Test" }] });
    if (req.url !== "/v1/messages" || req.method !== "POST") return send(404, { error: { message: "not found" } });
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const last = body.messages?.at(-1)?.content;
    const text = typeof last === "string" ? last : JSON.stringify(last);
    asked.push(text);
    const scripted = await out.script?.(body);
    if (scripted) return send(200, { stop_reason: "end_turn", model: body.model, usage: { input_tokens: 7, output_tokens: 5 }, ...scripted });
    // A vendor that repeats the key in what it says: the space must take it out again.
    if (/repeat the key/.test(text)) return send(400, { error: { message: `Your key ${key} can't do that` } });
    return send(200, { content: [{ type: "text", text: `You said: ${text}` }], stop_reason: "end_turn", model: body.model, usage: { input_tokens: 7, output_tokens: 5 } });
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const url = `http://127.0.0.1:${server.address().port}`;
  return Object.assign(out, { url, keys, asked, gateways: { "api.anthropic.com": url }, close: () => server.close() });
}

/**
 * @param {string} base @param {(what: string, ok: unknown, detail?: string) => void} check
 * @param {{ cookie: string, base: string, call: Function }} owner @param {() => any} person makes a new person
 * @param {Awaited<ReturnType<typeof fakeModel>>} vendor @param {string} folder where the host keeps everything
 * @param {() => Promise<string>} restart
 */
export async function spaceModelChecks(base, check, owner, person, vendor, folder, restart) {
  const said = [];
  const send = async (who, method, path, body, origin = base) => {
    const res = await fetch(`${base}/auth/spaces/${path}`, { method, headers: { ...(method !== "GET" && origin ? { origin } : {}), "content-type": "application/json", ...(who && { cookie: who.cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    said.push(text, JSON.stringify([...res.headers]));
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json };
  };
  const ask = (who, content, extra = {}) => send(who, "POST", "lab/model", { request: { messages: [{ role: "user", content }], ...extra } });

  await owner.call("/auth/spaces", { name: "lab" });
  const mel = await person().account("Mel");
  await mel.call("/auth/invites/accept", { token: (await owner.call("/auth/spaces/lab/invite", {})).body?.token });
  const stranger = await person().account("Nobody");

  const out = await send(null, "GET", "lab/model");
  const notIn = await ask(stranger, "hello");
  const elsewhere = await send(mel, "POST", "lab/model", { request: { messages: [{ role: "user", content: "hi" }] } }, "https://elsewhere.example");
  check("space model: only the space's members can ask about it or use it, and a page on another site can't", out.status === 401 && notIn.status === 401 && /Sign in, or ask its owner/.test(notIn.body.error ?? "") && elsewhere.status === 403, JSON.stringify([out, notIn, elsewhere]));

  const none = await send(mel, "GET", "lab/model");
  const early = await ask(mel, "hello");
  check("space model: a space with no key says so, and says what a member can do instead", none.status === 200 && none.body.set === false && none.body.vendors?.some((v) => v.id === "anthropic") && early.status === 409 && /owner can give it one on their account page/.test(early.body.error ?? ""), JSON.stringify([none.body, early]));

  const byMember = await send(mel, "POST", "lab/model/key", { vendor: "anthropic", key: KEY });
  const takenByMember = await send(mel, "DELETE", "lab/model/key");
  const noVendor = await send(owner, "POST", "lab/model/key", { vendor: "nobody", key: KEY });
  const noKey = await send(owner, "POST", "lab/model/key", { vendor: "anthropic", key: "two words" });
  check(
    "space model: only the owner gives the key or takes it away, and a vendor the site doesn't have or something that isn't a key is refused in words",
    byMember.status === 403 && takenByMember.status === 403 && noVendor.status === 400 && /Pick whose key it is/.test(noVendor.body.error ?? "") && noKey.status === 400 && /doesn't look like an API key/.test(noKey.body.error ?? ""),
    JSON.stringify([byMember, takenByMember, noVendor, noKey]),
  );

  const given = await send(owner, "POST", "lab/model/key", { vendor: "anthropic", key: KEY });
  const seen = await send(mel, "GET", "lab/model");
  check("space model: the owner gives a key, and members are told whose it is and for which model, not the key", given.status === 200 && given.body.set === true && seen.body.set === true && seen.body.model === "Claude" && seen.body.byName === "Owner" && seen.body.today === undefined, JSON.stringify([given, seen.body]));

  const before = vendor.keys.length;
  const answer = await ask(mel, "what is two and two?");
  check(
    "space model: a member with no key of their own gets an answer through the space's key, and is told who pays",
    answer.status === 200 && answer.body.answer?.text === "You said: what is two and two?" && answer.body.paidBy === "Owner" && answer.body.answer.usage?.input === 7 && vendor.keys.length > before && vendor.keys.slice(before).every((k) => k === KEY),
    JSON.stringify([answer, vendor.keys.slice(before).map((k) => k === KEY)]),
  );

  const models = await send(mel, "POST", "lab/model", { models: true });
  const bad = await send(mel, "POST", "lab/model", { request: { messages: [] } });
  const echoed = await ask(mel, "repeat the key");
  check(
    "space model: it lists the vendor's models, refuses a request that isn't one, and takes the key out of what a vendor says back",
    models.body.models?.[0]?.id === "claude-test-1" && bad.status === 400 && echoed.status === 502 && /\[secret\]/.test(echoed.body.error ?? ""),
    JSON.stringify([models.body, bad, echoed]),
  );

  const use = await send(owner, "GET", "lab/model");
  const mine = use.body.today?.find((m) => m.name === "Mel");
  check("space model: its owner sees what each member asked today", mine?.asked === 2 && mine.input === 7 && mine.output === 5 && (await send(mel, "GET", "lab/model")).body.asked === 2, JSON.stringify(use.body));

  // After a restart the key still unlocks: the lock is kept with the accounts, the key (encrypted) with the space.
  base = await restart();
  owner.base = mel.base = stranger.base = base;
  const later = await ask(mel, "still there?");
  check("space model: after a restart the space still answers on its key", later.status === 200 && later.body.answer?.text === "You said: still there?", JSON.stringify(later));

  // The key is in nothing the server sent, the copy of the space its owner can download, or anything either store keeps.
  const copy = await fetch(`${base}/auth/spaces/lab/export`, { headers: { cookie: owner.cookie } }).then((r) => r.text());
  let kept = "";
  try {
    kept = execFileSync("grep", ["-rlaF", KEY, folder], { encoding: "utf8" });
  } catch {}
  check(
    "space model: the key is in nothing a browser is sent, not in a copy of the space, and nowhere readable in what the server keeps",
    !said.some((text) => text.includes(KEY)) && copy.includes("extensible-web-apps/space") && !copy.includes(KEY) && !copy.includes("model-key.json") && kept.trim() === "",
    JSON.stringify({ said: said.filter((t) => t.includes(KEY)).length, copy: copy.includes(KEY), kept }),
  );

  // A key the vendor refuses: members are told whom to ask, and it isn't sent again.
  await send(owner, "POST", "lab/model/key", { vendor: "anthropic", key: BAD });
  const refused = await ask(mel, "hello?");
  const sent = vendor.keys.length;
  const again = await ask(mel, "hello again?");
  const state = await send(mel, "GET", "lab/model");
  check(
    "space model: a key the vendor refuses is marked, members are told whom to ask, and it isn't tried again",
    refused.status === 409 && /refused the key Owner gave this space/.test(refused.body.error ?? "") && again.status === 409 && vendor.keys.length === sent && state.body.refused === true,
    JSON.stringify([refused, again, state.body]),
  );

  const cleared = await send(owner, "DELETE", "lab/model/key");
  const gone = await ask(mel, "anyone?");
  check("space model: the owner takes the key away, and the space has no model again", cleared.status === 200 && cleared.body.set === false && gone.status === 409 && (await send(mel, "GET", "lab/model")).body.set === false, JSON.stringify([cleared, gone]));
}
