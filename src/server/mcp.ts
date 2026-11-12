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
// for it, and isn't asked on a timer either: the kernel says when what the door
// answers may have changed (KernelEnv.changed, from std/outside/module.ts), the
// accounts say when a key for the space ended, and only then does the host ask
// the door, a short request like any other, and send the notice if the tools
// did change. A stream lasts STREAM_MS (or until its key runs out, if that's
// sooner), then closes with a `retry` hint so the client opens another; a
// session has one stream at a time, the newest.
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
/** How often an open GET stream sends a comment, so the connection is seen to be alive. Nothing is asked for it. */
export const STREAM_BEAT_MS = 25_000;
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
 * How a host tells a stream to ask again: `watch(wake, lost)` calls `wake` each time the space's kernel says
 * what its door answers may have changed, or a key for the space ended, and gives back a way to stop. It
 * calls `lost` if it can no longer tell (the kernel stopped, or the connection it hears over closed): the
 * stream ends then, and the client opens another, since nothing would wake it again.
 */
export type Watch = (wake: () => void, lost: () => void) => (() => void) | Promise<() => void>;

/**
 * A client's GET stream, kept open by the host. It asks the kernel (`ask`, the door `mcp`) once as it opens,
 * and after that only when the host's `watch` wakes it: then it checks the key still works (`key`), asks the
 * door whether the tools changed, and sends a notice when they did. Nothing is asked on a timer; a comment
 * goes out every `beat` so the connection is seen to be alive. It ends after `life`, when its key runs out or
 * stops working, when the door says the session or stream is over (the client ended the session, or
 * opened a newer stream), or when the host can no longer tell it of changes (`watch` says it's lost). An answer other than 200 to the first ask is the response.
 */
export async function mcpStream(
  asked: RouteRequest,
  ask: (request: RouteRequest) => Promise<RouteResponse | null>,
  watch: Watch,
  options: {
    beat?: number;
    life?: number;
    key?: () => Promise<{ expires?: number } | null>;
    /** How a notice goes out, for a door whose notices carry their own event ids (src/server/acp.ts): its id and its message. */
    frame?: (notice: unknown) => { id: string; data: unknown };
    /** More to ask the door with each time, such as the last notice sent. */
    query?: () => Record<string, string>;
  } = {},
): Promise<Response> {
  const { beat = STREAM_BEAT_MS, life = STREAM_MS, key = async (): Promise<{ expires?: number } | null> => ({}) } = options;
  const knock = (first: boolean) => ask({ ...asked, query: { ...asked.query, ...options.query?.(), ...(first ? { first: "1" } : {}) } }).catch(() => null);
  // Watching starts before the first ask, so a change between that ask and the stream opening isn't missed.
  let woken = false;
  let wake = () => void (woken = true);
  let gone = false;
  let lost: () => void = () => void (gone = true);
  const stop = await watch(
    () => wake(),
    () => lost(),
  );
  let opened: RouteResponse | null = null;
  let held: { expires?: number } | null = null;
  try {
    held = await key().catch(() => null);
    opened = held && (await knock(true));
  } finally {
    if (!opened || opened.status !== 200) stop();
  }
  if (!held) return rpcError(401, "That key doesn't work any more");
  if (!opened || opened.status !== 200) return mcpResponse(opened);
  const first = opened;
  const encoder = new TextEncoder();
  const tag = asked.query?.stream?.slice(0, 8) ?? "s";
  let sent = 0;
  const events = (result: RouteResponse) =>
    (((result.json ?? {}) as McpAnswer).notices ?? [])
      .map((message) => {
        const { id, data } = options.frame?.(message) ?? { id: `${tag}-${++sent}`, data: message };
        return `id: ${id}\nevent: message\ndata: ${JSON.stringify(data)}\n\n`;
      })
      .join("");
  let timers: ReturnType<typeof setTimeout>[] = [];
  let over = false;
  const finish = () => {
    over = true;
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    stop();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const end = () => {
        if (over) return;
        finish();
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
      // It ends when its time is up, or its key's is (a key a client signed in for lasts an hour).
      let ending: ReturnType<typeof setTimeout> | undefined;
      const endAt = (at: number) => {
        if (ending !== undefined) clearTimeout(ending);
        timers = timers.filter((t) => t !== ending);
        timers.push((ending = setTimeout(end, Math.max(0, at - Date.now()))));
      };
      const until = Date.now() + life;
      endAt(Math.min(until, held?.expires ?? Infinity));
      const beating = setInterval(() => send(": still here\n\n"), beat);
      timers.push(beating as unknown as ReturnType<typeof setTimeout>);

      // One look at a time; a wake during a look means one more look after it.
      let looking = false;
      let again = false;
      const look = async () => {
        if (over) return;
        if (looking) return void (again = true);
        looking = true;
        try {
          do {
            again = false;
            // The key first: revoked, renewed, run out, or the member gone, and the stream ends.
            const now = await key().catch(() => null);
            if (over) return;
            if (!now) return end();
            endAt(Math.min(until, now.expires ?? Infinity));
            const result = await knock(false);
            if (over) return;
            // The session ended, a newer stream took over, or the space didn't answer: the client opens another if it still wants one.
            if (!result || result.status !== 200) return end();
            const said = events(result);
            if (said) send(said);
          } while (again && !over);
        } finally {
          looking = false;
        }
      };
      wake = () => void look();
      lost = end;
      send(`retry: ${RETRY_MS}\n\n${events(first)}`);
      if (gone) end();
      else if (woken) void look();
    },
    cancel() {
      finish();
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
