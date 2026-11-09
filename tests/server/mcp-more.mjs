// More of a space's MCP server, on each host:
//
// - An agent signs in with OAuth instead of a pasted key
//   (src/server/auth/mcp-oauth.ts): the 401 points at the metadata, the client
//   registers, the member says yes on this site's page, and the client trades
//   the code for an agent key, which /account/ lists and can revoke.
// - An app opens the door with an agent file alone (`outside: true`,
//   src/kernel/agents/file.ts): tests/fixtures/server-app/outside/.
// - When the door's tools change, a connected client is told
//   (notifications/tools/list_changed), ahead of the answer to its next request.

import { device } from "./mcp.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const sha256 = async (text) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

/** The messages in an event-stream answer, or the JSON one. */
async function messages(response) {
  const text = await response.text();
  if (!/text\/event-stream/.test(response.headers.get("content-type") ?? "")) return [JSON.parse(text || "null")];
  return text
    .split("\n\n")
    .map((event) => event.split("\n").find((l) => l.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)));
}

export async function mcpMoreChecks(base, check, owner, stranger) {
  await owner.call("/auth/spaces", { name: "jots" });
  const address = `${base}/s/jots/mcp/jots-door`;
  const back = "http://127.0.0.1:33418/callback";

  // Signing in, as an MCP client does it.
  const knocked = await fetch(address, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  const pointer = /resource_metadata="([^"]+)"/.exec(knocked.headers.get("www-authenticate") ?? "")?.[1];
  check("mcp sign-in: without a key, the server's 401 says where to find how to sign in", knocked.status === 401 && pointer === `${base}/.well-known/oauth-protected-resource/s/jots/mcp/jots-door`, String(knocked.headers.get("www-authenticate")));
  const resource = await fetch(pointer ?? `${base}/.well-known/oauth-protected-resource`).then((r) => r.json());
  const server = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  check(
    "mcp sign-in: the address's metadata names this site as the server that signs agents in, and its endpoints need PKCE",
    resource.resource === address && resource.authorization_servers?.[0] === base && server.issuer === base && server.code_challenge_methods_supported?.includes("S256") && server.registration_endpoint === `${base}/auth/mcp/register`,
    JSON.stringify({ resource, server }),
  );

  const register = (body) => fetch(`${base}/auth/mcp/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const registered = await register({ client_name: "Test agent", redirect_uris: [back] });
  const sneaky = await register({ client_name: "Sneaky", redirect_uris: ["http://elsewhere.example/callback"] });
  const secretful = await register({ client_name: "Confidential", redirect_uris: [back], token_endpoint_auth_method: "client_secret_basic" });
  check("mcp sign-in: a client registers, sent back only to https, this machine or an app's own scheme, and without a secret", registered.status === 201 && registered.body.client_id && sneaky.status === 400 && secretful.status === 400, JSON.stringify([registered, sneaky.status, secretful.status]));
  const client = registered.body.client_id;

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const params = async (extra = {}) =>
    new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: back, state: "s-1", code_challenge: await sha256(verifier), code_challenge_method: "S256", resource: address, ...extra });
  const authorize = async (cookie, extra) => fetch(`${base}/auth/mcp/authorize?${await params(extra)}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  const signedOut = await authorize("");
  const consent = await authorize(owner.cookie);
  const page = await consent.text();
  const notMember = await authorize(stranger.cookie);
  const elsewhere = await authorize(owner.cookie, { redirect_uri: "https://elsewhere.example/cb" });
  check(
    "mcp sign-in: the page asks someone signed out to sign in, a member to connect the agent to the space, and refuses anyone else",
    /Sign in/.test(await signedOut.text()) && consent.status === 200 && /Test agent/.test(page) && /jots/.test(page) && /form-action 'self' http:\/\/127\.0\.0\.1:33418/.test(consent.headers.get("content-security-policy") ?? "") && notMember.status === 403 && elsewhere.status === 400,
    JSON.stringify([signedOut.status, consent.status, notMember.status, elsewhere.status]),
  );

  const answer = async (choice, { origin = base } = {}) =>
    fetch(`${base}/auth/mcp/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: owner.cookie, ...(origin ? { origin } : {}) }, body: `${await params()}&answer=${choice}`, redirect: "manual" });
  const forged = await answer("allow", { origin: "https://elsewhere.example" });
  const declined = new URL((await answer("deny")).headers.get("location") ?? "http://x/");
  check("mcp sign-in: only this site's page answers, and no sends the agent back with access_denied", forged.status === 403 && declined.searchParams.get("error") === "access_denied" && declined.searchParams.get("state") === "s-1", JSON.stringify([forged.status, declined.href]));

  const codeFrom = async () => new URL((await answer("allow")).headers.get("location") ?? "http://x/");
  const trade = (code, v = verifier) =>
    fetch(`${base}/auth/mcp/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: back, client_id: client, code_verifier: v, resource: address }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const first = await codeFrom();
  const wrong = await trade(first.searchParams.get("code") ?? "", b64url(crypto.getRandomValues(new Uint8Array(32))));
  const again = await trade(first.searchParams.get("code") ?? "");
  check("mcp sign-in: a code needs the verifier its challenge was made from, and works only once", first.searchParams.get("iss") === base && wrong.body.error === "invalid_grant" && again.body.error === "invalid_grant", JSON.stringify([first.href, wrong, again]));
  const traded = await trade((await codeFrom()).searchParams.get("code") ?? "");
  const token = traded.body.access_token;
  await trade((await codeFrom()).searchParams.get("code") ?? "").then((t) => t.body.access_token && (traded.replaced = t.body.access_token));
  const keys = (await owner.call("/auth/keys")).body?.keys?.filter((k) => k.space === "jots") ?? [];
  check(
    "mcp sign-in: the client gets an agent key for the space, listed on /account/ under its name, and connecting again replaces it",
    traded.status === 200 && /^ewa_/.test(token ?? "") && traded.body.token_type === "Bearer" && keys.length === 1 && keys[0].name === "Test agent",
    JSON.stringify({ traded, keys }),
  );
  const key = traded.replaced;

  // The app links only an outside agent file; a member's device opens it in the space, which opens the door.
  const phone = await device(base, "jots", owner.cookie);
  phone.app("server-app/outside");
  let id = 0;
  const rpc = (method, params, { session, streams = true, auth = key } = {}) =>
    fetch(address, {
      method: "POST",
      headers: { "content-type": "application/json", accept: streams ? "application/json, text/event-stream" : "application/json", authorization: `Bearer ${auth}`, ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }),
    });
  const stale = await rpc("tools/list", undefined, { auth: token });
  check("mcp sign-in: a key the client was given before connecting again stops working", stale.status === 401, String(stale.status));
  let init;
  let body;
  for (let i = 0; i < 40 && body?.result?.serverInfo?.name !== "Jots for agents"; i++) {
    if (i) await wait(250);
    init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "checks", version: "1" } });
    body = (await messages(init))[0];
  }
  const session = init?.headers.get("mcp-session-id");
  check(
    "outside agent file: an app opens the space's MCP door with an agent file alone, its text the server's instructions",
    body?.result?.serverInfo?.name === "Jots for agents" && /short notes/.test(body.result.instructions ?? ""),
    JSON.stringify(body),
  );
  check("mcp: a client gets a session when it connects, and is told the server says when its tools change", /^[0-9a-f]{32}$/.test(session ?? "") && body?.result?.capabilities?.tools?.listChanged === true, JSON.stringify([session, body?.result?.capabilities]));

  const before = (await messages(await rpc("tools/list", undefined, { session })))[0]?.result?.tools?.map((t) => t.name) ?? [];
  // Another app in the space brings a collection the door may read: its tools change.
  phone.app("server-app/outside/more");
  let heard = [];
  for (let i = 0; i < 40 && heard[0]?.method !== "notifications/tools/list_changed"; i++) {
    await wait(250);
    heard = await messages(await rpc("ping", undefined, { session }));
  }
  const repeat = await messages(await rpc("ping", undefined, { session }));
  const after = (await messages(await rpc("tools/list", undefined, { session })))[0]?.result?.tools?.map((t) => t.name) ?? [];
  check(
    "mcp: when the door's tools change, the session's next answer comes after notifications/tools/list_changed, once",
    !before.some((n) => n.includes("jot")) && heard[0]?.method === "notifications/tools/list_changed" && heard[1]?.result && repeat.length === 1 && after.includes("data_list_jot-notes"),
    JSON.stringify({ before, heard, repeat, after }),
  );

  // A session the server doesn't know (the space's kernel restarted since) is taken up again, and told to list the tools afresh.
  const restored = await messages(await rpc("ping", undefined, { session: "0123456789abcdef0123456789abcdef" }));
  const otherDoor = await fetch(`${base}/s/jots/mcp/reading-list-agents`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  check(
    "mcp: a session the server lost is taken up again and told to list the tools; a signed-in key reaches only the door the member said yes to",
    restored[0]?.method === "notifications/tools/list_changed" && restored[1]?.result && otherDoor.status === 401,
    JSON.stringify([restored, otherDoor.status]),
  );

  const ended = await fetch(address, { method: "DELETE", headers: { authorization: `Bearer ${key}`, "mcp-session-id": session ?? "" } });
  const afterEnd = await rpc("ping", undefined, { session });
  const getStream = await fetch(address, { headers: { authorization: `Bearer ${key}`, accept: "text/event-stream" } });
  check("mcp: a client ends its session with DELETE, after which it is unknown; there is no GET stream", ended.status === 200 && afterEnd.status === 404 && getStream.status === 405, JSON.stringify([ended.status, afterEnd.status, getStream.status]));
  phone.close();
}
