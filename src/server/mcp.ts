// A space's MCP server, on either host: /s/<space>/mcp/<plugin>, where an
// agent outside the browser (Claude Code, any MCP client) uses the tools a
// plugin of the space opened to outside agents (std/outside/module.ts).
//
// Unlike a public route, only a member's agent may call it: the request must
// carry one of their agent keys (src/server/auth/agent-keys.ts) for this
// space, as `Authorization: Bearer <key>`. The host checks the key, then
// hands the kernel the JSON-RPC body as the door `mcp`, with the member it is
// for, on the same way in as a public route's request.
//
// This is MCP's Streamable HTTP transport. Each POST is answered with JSON,
// or, when the door's tools changed since the client last heard, with a short
// event stream that carries notifications/tools/list_changed ahead of the
// answer. A client gets a session (Mcp-Session-Id) when it connects and may
// end it with DELETE.
//
// A client that sits idle hears about a change too: it opens a GET stream with
// its session, and the host keeps it open (mcpStream). The kernel isn't held
// for it: the host asks the door every STREAM_POLL_MS whether the tools
// changed, a short request like any other, and sends the notice when they did.
// A stream lasts STREAM_MS, then closes with a `retry` hint so the client opens
// another; a session has one stream at a time, the newest.
//
// An agent without a key can sign in instead: the 401 points it at the
// OAuth metadata for this address (src/server/auth/mcp-oauth.ts), and the
// member says yes on a page of this site, which makes an agent key for it.

import type { RouteRequest, RouteResponse } from "./routes.ts";

/** How long the host waits for the kernel's answer: long enough for a person to answer a review. */
export const MCP_TIMEOUT_MS = 120_000;
const MAX_BODY = 256 * 1024;
const PLUGIN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SESSION = /^[0-9a-f]{32}$/;
/** How often an open GET stream asks the door whether the tools changed. */
export const STREAM_POLL_MS = 10_000;
/** How long a GET stream stays open before the client is asked to open another. */
export const STREAM_MS = 30 * 60_000;
/** How long a client waits before opening the stream again (SSE's `retry`). */
const RETRY_MS = 3_000;

/** What the door (std/outside/module.ts) answers in `json`: the JSON-RPC answer, the client's session, and notices to send first. */
interface McpAnswer {
  reply?: unknown;
  session?: string;
  notices?: unknown[];
}

/** Where an MCP address's OAuth metadata is (RFC 9728): the well-known path with the address after it. */
export const resourceMetadata = (url: URL) => `${url.origin}/.well-known/oauth-protected-resource${url.pathname.replace(/\/$/, "")}`;

/** The space and plugin of an MCP address, or undefined for any other. */
export function mcpAddress(url: URL): { space: string; plugin: string } | undefined {
  const match = /^\/s\/([^/]+)\/mcp\/([^/]+)\/?$/.exec(url.pathname);
  return match && PLUGIN.test(match[2]) ? { space: match[1], plugin: match[2] } : undefined;
}

const answer = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "cache-control": "no-store", ...headers } });

const rpcError = (status: number, message: string, headers: Record<string, string> = {}) => answer(status, { jsonrpc: "2.0", id: null, error: { code: -32000, message } }, headers);

/**
 * Everything the host does before the kernel sees an MCP request: the method, the origin, the key and the
 * body. Gives the kernel's request, or the response to send instead.
 */
export async function mcpRequest(
  request: Request,
  at: { space: string; plugin: string },
  member: (authorization: string | null, space: string, plugin: string) => Promise<{ user: string } | null>,
): Promise<RouteRequest | Response> {
  const url = new URL(request.url);
  // A page on another site may not call it from someone's browser (MCP's advice against DNS rebinding);
  // an agent that isn't a browser sends no Origin.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return rpcError(403, "Not from this site");
  if (request.method !== "POST" && request.method !== "DELETE" && request.method !== "GET") return answer(405, undefined, { allow: "GET, POST, DELETE" });
  const authorization = request.headers.get("authorization");
  const who = await member(authorization, at.space, at.plugin).catch(() => null);
  if (!who)
    return rpcError(401, "This needs an agent key for the space: sign in when your agent asks, or make one on /account/ and send it as Authorization: Bearer <key>", {
      // A key that was sent but doesn't work (most often a signed-in client's, run out): the client refreshes it.
      "www-authenticate": `Bearer realm="space", resource_metadata="${resourceMetadata(url)}"${authorization ? ', error="invalid_token"' : ""}`,
    });
  const session = request.headers.get("mcp-session-id") ?? "";
  if (session && !SESSION.test(session)) return rpcError(400, "That isn't a session this server gave");
  // Whether the client takes an event stream as the answer, which is how a change to the tools reaches it.
  const streams = /\btext\/event-stream\b/i.test(request.headers.get("accept") ?? "") ? "1" : "";
  const query = { session, streams };
  if (request.method === "DELETE") return { method: "DELETE", path: `/mcp/${at.plugin}`, door: "mcp", member: who.user, query };
  if (request.method === "GET") {
    // The stream a connected client keeps open to hear about changes (mcpStream).
    if (!streams) return rpcError(406, "The stream is an event stream: Accept: text/event-stream");
    if (!session) return rpcError(400, "Connect first (initialize), then open the stream with the Mcp-Session-Id you were given");
    return { method: "GET", path: `/mcp/${at.plugin}`, door: "mcp", member: who.user, query: { session, stream: randomHex() } };
  }
  const text = await readText(request);
  if (text === null) return rpcError(413, "That's more than this server reads");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return answer(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Not JSON" } });
  }
  return { method: "POST", path: `/mcp/${at.plugin}`, door: "mcp", member: who.user, form: body, query };
}

/** The kernel's answer as an HTTP response. */
export function mcpResponse(result: RouteResponse | null): Response {
  if (!result) return rpcError(503, "The space didn't answer");
  const status = Number.isInteger(result.status) ? result.status! : 200;
  if ("json" in result) {
    const { reply, session, notices } = (result.json ?? {}) as McpAnswer;
    const headers: Record<string, string> = session ? { "mcp-session-id": session } : {};
    if (!notices?.length) return answer(status, reply, headers);
    // Notices first, then the answer, as one short event stream.
    const events = [...notices, reply].map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join("");
    return new Response(events, { status, headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...headers } });
  }
  if (status === 200 || status === 202) return answer(status === 200 ? 200 : 202);
  // The host's own failure (the space didn't answer in time): still a JSON-RPC error, which an MCP client can read.
  return rpcError(status, typeof result.text === "string" && result.text ? result.text : "The space couldn't answer");
}

const randomHex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A client's GET stream, kept open by the host: it asks the kernel (`ask`, the door `mcp`) at once whether
 * the tools changed, then every `poll`, and sends a notice when they did, or a comment so the connection is
 * seen to be alive. It ends after `life`, or when the door says the session or stream is over (the client
 * ended the session, or opened a newer stream). An answer other than 200 to the first ask is the response.
 */
export async function mcpStream(
  asked: RouteRequest,
  ask: (request: RouteRequest) => Promise<RouteResponse | null>,
  timing: { poll?: number; life?: number } = {},
): Promise<Response> {
  const { poll = STREAM_POLL_MS, life = STREAM_MS } = timing;
  const knock = (first: boolean) => ask({ ...asked, query: { ...asked.query, ...(first ? { first: "1" } : {}) } }).catch(() => null);
  const opened = await knock(true);
  if (!opened || opened.status !== 200) return mcpResponse(opened);
  const encoder = new TextEncoder();
  const tag = asked.query?.stream?.slice(0, 8) ?? "s";
  let sent = 0;
  const events = (result: RouteResponse) =>
    (((result.json ?? {}) as McpAnswer).notices ?? []).map((message) => `id: ${tag}-${++sent}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`).join("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let over = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const until = Date.now() + life;
      const end = () => {
        if (over) return;
        over = true;
        if (timer !== undefined) clearTimeout(timer);
        try {
          controller.close();
        } catch {}
      };
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          end();
        }
      };
      const next = () =>
        (timer = setTimeout(async () => {
          if (over) return;
          if (Date.now() >= until) return end();
          const result = await knock(false);
          if (over) return;
          // The session ended, a newer stream took over, or the space didn't answer: the client opens another if it still wants one.
          if (!result || result.status !== 200) return end();
          send(events(result) || ": still here\n\n");
          next();
        }, Math.min(poll, Math.max(0, until - Date.now()))));
      send(`retry: ${RETRY_MS}\n\n${events(opened)}`);
      next();
    },
    cancel() {
      over = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

/** The body as text, read only up to MAX_BODY bytes: null, without reading the rest, if it's longer. */
async function readText(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) all.set(chunk, (at += chunk.byteLength) - chunk.byteLength);
  return new TextDecoder().decode(all);
}
