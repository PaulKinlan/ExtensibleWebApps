// A space's MCP server, a third pass, on each host:
//
// - A connected client that sits idle hears when the door's tools change: it
//   keeps a GET stream open, and the host asks the door when the kernel says
//   something may have changed, never on a timer (src/server/mcp.ts
//   mcpStream). A session has one stream, the newest.
// - The key a signed-in client gets lasts an hour, and comes with a refresh
//   token it trades for a new key in the old one's place
//   (src/server/auth/mcp-oauth.ts). A spent refresh token used again revokes
//   the key; revoking on /account/ stops the refreshing.
// - Someone signed out signs in on the page that asks them, and comes back to
//   it: with a passkey there (signin.js), or with another site (`return`).

import { mcpStream } from "../../src/server/mcp.ts";
import { device } from "./mcp.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const sha256 = async (text) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

/** Reads an event stream as it comes: the messages so far, and whether it has ended. */
function listen(response) {
  const heard = { messages: [], retry: undefined, ended: false, comments: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  heard.done = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) heard.messages.push(JSON.parse(line.slice(6)));
          else if (line.startsWith("retry: ")) heard.retry = Number(line.slice(7));
          else if (line.startsWith(":")) heard.comments++;
        }
      }
    }
    heard.ended = true;
  })();
  heard.stop = () => reader.cancel().catch(() => {});
  return heard;
}

/** Waits for a condition, up to `ms`. */
async function until(test, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(250)) if (test()) return true;
  return test();
}

/** Signing in with the fake other site (tests/server/fake-oauth.mjs), following its redirects: where the callback sends the browser. */
async function fakeSignIn(base, query) {
  let cookie = "";
  const get = async (url) => {
    const res = await fetch(url, { redirect: "manual", headers: { cookie } });
    const set = res.headers.getSetCookie?.().find((c) => c.startsWith("ewa-oauth="));
    if (set) cookie = set.split(";")[0];
    return res;
  };
  const start = await get(`${base}/auth/oauth/fake/start${query}`);
  const atProvider = await get(start.headers.get("location"));
  const back = await get(atProvider.headers.get("location"));
  return { status: back.status, location: back.headers.get("location") };
}

/**
 * The stream by itself, with a stand-in for the kernel and the host: it asks the door once as it opens, and
 * again only when it is woken.
 */
export async function quietStreamChecks(check) {
  const asks = [];
  let changed = false;
  let wake;
  let stopped = 0;
  let key = {};
  const ask = async (request) => {
    asks.push(request.query?.first ? "first" : "again");
    const notices = changed ? [{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }] : [];
    changed = false;
    return { status: 200, json: { notices } };
  };
  const watch = (w) => ((wake = w), () => void stopped++);
  const open = (options = {}) => mcpStream({ method: "GET", path: "/mcp/door", door: "mcp", member: "m", query: { session: "s", stream: "abcdef0123456789" } }, ask, watch, { beat: 40, key: async () => key, ...options });
  const idle = listen(await open());
  await wait(400);
  const whileIdle = { asks: [...asks], comments: idle.comments, messages: idle.messages.length };
  // Something may have changed, but didn't: the door is asked, and nothing is sent. Then it did.
  wake();
  await wait(100);
  const afterNothing = { asks: asks.length, messages: idle.messages.length };
  changed = true;
  wake();
  wake();
  await until(() => idle.messages.length > 0, 2000);
  await wait(100);
  const afterChange = { asks: asks.length, messages: idle.messages.length };
  check(
    "mcp stream: an open stream asks the kernel once as it opens and then only when told something may have changed, never on a timer; comments keep the connection alive meanwhile",
    whileIdle.asks.join() === "first" && whileIdle.comments >= 3 && whileIdle.messages === 0 && afterNothing.asks === 2 && afterNothing.messages === 0 && afterChange.messages === 1 && afterChange.asks <= 4,
    JSON.stringify({ whileIdle, afterNothing, afterChange }),
  );
  // Its key stops working: the next time it's woken, it ends, and stops watching.
  key = null;
  wake();
  const cut = await until(() => idle.ended, 2000);
  // A key that runs out ends the stream then, with nothing asked; so does the stream's own time.
  const before = asks.length;
  key = { expires: Date.now() + 150 };
  const short = listen(await open());
  const ranOut = await until(() => short.ended, 2000);
  key = {};
  const brief = listen(await open({ life: 150 }));
  const timeUp = await until(() => brief.ended, 2000);
  check(
    "mcp stream: it ends when its key stops working, when the key runs out, and when its own time is up, and stops watching each time",
    cut && ranOut && timeUp && asks.length === before + 2 && stopped === 3,
    JSON.stringify({ cut, ranOut, timeUp, asks: asks.length - before, stopped }),
  );
}

export async function mcpStreamChecks(base, check, owner, stranger) {
  await owner.call("/auth/spaces", { name: "pinboard" });
  const address = `${base}/s/pinboard/mcp/jots-door`;
  const back = "http://127.0.0.1:33419/callback";

  // A client registers and the member connects it, as in mcp-more.mjs.
  const client = (await fetch(`${base}/auth/mcp/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Idle agent", redirect_uris: [back] }) }).then((r) => r.json())).client_id;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const params = async () => new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: back, state: "s-2", code_challenge: await sha256(verifier), code_challenge_method: "S256", resource: address });
  const connect = async () => {
    const yes = await fetch(`${base}/auth/mcp/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: owner.cookie, origin: base }, body: `${await params()}&answer=allow`, redirect: "manual" });
    const code = new URL(yes.headers.get("location") ?? "http://x/").searchParams.get("code") ?? "";
    return token({ grant_type: "authorization_code", code, redirect_uri: back, client_id: client, code_verifier: verifier, resource: address });
  };
  const token = (body) => fetch(`${base}/auth/mcp/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const ours = async () => (await owner.call("/auth/keys")).body?.keys?.filter((k) => k.space === "pinboard") ?? [];

  const first = await connect();
  const listed = await ours();
  check(
    "mcp sign-in: the key a client gets lasts an hour and comes with a refresh token; /account/ lists when it runs out",
    first.status === 200 && first.body.expires_in === 3600 && /^[A-Za-z0-9_-]{43}$/.test(first.body.refresh_token ?? "") && listed.length === 1 && Math.abs(listed[0].expires - (Date.now() + 3_600_000)) < 120_000,
    JSON.stringify({ first, listed }),
  );
  const server = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  check("mcp sign-in: the server's metadata says it takes refresh tokens", server.grant_types_supported?.includes("refresh_token"), JSON.stringify(server.grant_types_supported));

  const phone = await device(base, "pinboard", owner.cookie);
  phone.app("server-app/outside");
  const ping = (key) => fetch(address, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });

  const refresh = (refresh_token, extra = {}) => token({ grant_type: "refresh_token", refresh_token, client_id: client, ...extra });
  const wrongClient = await refresh(first.body.refresh_token, { client_id: "c_e30" });
  const second = await refresh(first.body.refresh_token);
  const oldKey = await ping(first.body.access_token);
  const newKey = await ping(second.body.access_token);
  const after = await ours();
  check(
    "mcp sign-in: a client trades its refresh token for a new key in the old one's place (the same entry on /account/), and the old key stops working",
    wrongClient.body.error === "invalid_grant" &&
      second.status === 200 &&
      second.body.access_token !== first.body.access_token &&
      second.body.refresh_token !== first.body.refresh_token &&
      oldKey.status === 401 &&
      /error="invalid_token"/.test(oldKey.headers.get("www-authenticate") ?? "") &&
      newKey.status === 200 &&
      after.length === 1 &&
      after[0].id === listed[0].id,
    JSON.stringify({ wrongClient, second, old: oldKey.status, new: newKey.status, after }),
  );

  const replayed = await refresh(first.body.refresh_token);
  const thenKey = await ping(second.body.access_token);
  const thenRefresh = await refresh(second.body.refresh_token);
  check(
    "mcp sign-in: a spent refresh token used again means it was copied: the key is revoked, and its newer refresh token stops working too",
    replayed.body.error === "invalid_grant" && thenKey.status === 401 && thenRefresh.body.error === "invalid_grant" && (await ours()).length === 0,
    JSON.stringify({ replayed, thenKey: thenKey.status, thenRefresh }),
  );

  const third = await connect();
  await owner.call("/auth/keys/revoke", { id: (await ours())[0]?.id });
  const revoked = await refresh(third.body.refresh_token);
  check("mcp sign-in: revoking the key on /account/ ends its refreshing", third.status === 200 && revoked.body.error === "invalid_grant", JSON.stringify({ third: third.status, revoked }));

  // The stream: connect, open it, and hear a change with no request in between.
  const key = (await connect()).body.access_token;
  const rpc = (method, extra = {}) =>
    fetch(address, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}`, ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "checks", version: "1" } } }) });
  let session;
  for (let i = 0; i < 40 && !session; i++) {
    if (i) await wait(250);
    const init = await rpc("initialize");
    if (init.status === 200 && /Jots for agents/.test(await init.text())) session = init.headers.get("mcp-session-id");
  }
  const open = (extra = {}) => fetch(address, { headers: { accept: "text/event-stream", authorization: `Bearer ${key}`, "mcp-session-id": session ?? "", ...extra } });
  const noSession = await fetch(address, { headers: { accept: "text/event-stream", authorization: `Bearer ${key}` } });
  const noAccept = await open({ accept: "application/json" });
  const stream = await open();
  const heard = listen(stream);
  await until(() => heard.retry !== undefined, 5000);
  check(
    "mcp stream: a connected client opens a GET stream with its session (not without one, and only as an event stream), told how soon to open another",
    noSession.status === 400 && noAccept.status === 406 && stream.status === 200 && stream.headers.get("content-type") === "text/event-stream" && heard.retry > 0 && !heard.messages.length,
    JSON.stringify({ noSession: noSession.status, noAccept: noAccept.status, stream: stream.status, heard }),
  );

  // Another app in the space brings a collection the door may read: the idle client hears, on the stream.
  phone.app("server-app/outside/more");
  const changed = await until(() => heard.messages.some((m) => m.method === "notifications/tools/list_changed"), 30_000);
  const piggyback = await rpc("ping", { "mcp-session-id": session ?? "" }).then((r) => r.text());
  check(
    "mcp stream: when the door's tools change, a client that sent nothing hears notifications/tools/list_changed on its stream, once (not again on its next answer)",
    changed && heard.messages.length === 1 && !/list_changed/.test(piggyback),
    JSON.stringify({ heard: heard.messages, piggyback }),
  );

  // A newer stream for the session takes over; ending the session ends it.
  const newer = listen(await open());
  const tookOver = await until(() => heard.ended, 30_000);
  await fetch(address, { method: "DELETE", headers: { authorization: `Bearer ${key}`, "mcp-session-id": session ?? "" } });
  const endedToo = await until(() => newer.ended, 30_000);
  check("mcp stream: a session has one stream, the newest, and ending the session closes it", tookOver && endedToo, JSON.stringify({ tookOver, endedToo }));
  heard.stop();
  newer.stop();

  // The key is checked again while the stream is open: revoked, and the stream ends.
  const later = (await connect()).body.access_token;
  const init = await fetch(address, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${later}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  const watched = listen(await fetch(address, { headers: { accept: "text/event-stream", authorization: `Bearer ${later}`, "mcp-session-id": init.headers.get("mcp-session-id") ?? "" } }));
  await until(() => watched.retry !== undefined, 5000);
  await owner.call("/auth/keys/revoke", { id: (await ours())[0]?.id });
  const cut = await until(() => watched.ended, 30_000);
  check("mcp stream: revoking the key ends a stream that's open", watched.retry > 0 && cut, JSON.stringify({ retry: watched.retry, cut }));
  watched.stop();
  phone.close();

  // Leaving the space ends a member's keys for it, so joining again doesn't bring them back.
  const invite = async () => (await owner.call("/auth/spaces/pinboard/invite", {})).body?.token;
  await stranger.call("/auth/invites/accept", { token: await invite() });
  const theirs = (await stranger.call("/auth/keys", { space: "pinboard", name: "Their agent" })).body?.key;
  const before = (await ping(theirs)).status;
  await stranger.call("/auth/spaces/pinboard/leave", {});
  await stranger.call("/auth/invites/accept", { token: await invite() });
  const rejoined = (await ping(theirs)).status;
  const kept = ((await stranger.call("/auth/keys")).body?.keys ?? []).filter((k) => k.space === "pinboard");
  check("agent keys: leaving a space ends the member's keys for it, and joining again doesn't bring them back", before === 200 && rejoined === 401 && kept.length === 0, JSON.stringify({ before, rejoined, kept }));

  // Signed out on the page that asks: sign in right there, or with another site that brings you back.
  const asked = `${base}/auth/mcp/authorize?${await params()}`;
  const page = await fetch(asked, { redirect: "manual" });
  const html = await page.text();
  const script = await fetch(`${base}/auth/mcp/signin.js`);
  const returnTo = /name="return" value="([^"]+)"/.exec(html)?.[1]?.replaceAll("&#38;", "&");
  check(
    "mcp sign-in: someone signed out signs in on the page itself, with a passkey or another site, and the page carries on once they're signed in elsewhere",
    /id="passkey"/.test(html) &&
      /src="\/auth\/mcp\/signin\.js"/.test(html) &&
      /script-src 'self'/.test(page.headers.get("content-security-policy") ?? "") &&
      // Another site's sign-in starts on this site and redirects there, which Chromium holds to form-action too.
      /form-action 'self' https: http:/.test(page.headers.get("content-security-policy") ?? "") &&
      /action="\/auth\/oauth\/fake\/start"/.test(html) &&
      returnTo?.startsWith("/auth/mcp/authorize?") &&
      script.status === 200 &&
      /javascript/.test(script.headers.get("content-type") ?? "") &&
      /\/auth\/me/.test(await script.text()),
    html.slice(0, 1500),
  );
  if (returnTo) {
    const returned = await fakeSignIn(base, `?return=${encodeURIComponent(returnTo)}`);
    const elsewhere = await fakeSignIn(base, `?return=${encodeURIComponent("https://elsewhere.example/")}`);
    check(
      "mcp sign-in: signing in with another site from that page comes back to it, and never anywhere else",
      returned.status === 303 && returned.location === returnTo && elsewhere.location === "/account/",
      JSON.stringify({ returned, elsewhere, returnTo }),
    );
  }
}
