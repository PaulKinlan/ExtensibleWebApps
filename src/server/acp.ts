// An editor talking to one of a space's agents, on either host:
// /s/<space>/acp/<agent>, where an ACP client (the Agent Client Protocol,
// https://agentclientprotocol.com) reaches an agent an app in the space links
// (std/acp/module.ts). The mirror of the MCP door beside it (mcp.ts): there an
// agent outside uses the app's tools; here the app's own agent is talked to
// from outside.
//
// As there, only a member's agent key gets in (`Authorization: Bearer <key>`),
// and the host hands the kernel each JSON-RPC message at the door `acp`, with
// the member it is for. Two things more go with it:
//
// - whether the key was made for this editor and agent (a key with `editor`
//   set, auth/agent-keys.ts). Only then may the editor's own prompt answer the
//   agent's reviews; with any other key they wait on the member's devices.
// - with a prompt, what unlocks the model key the space holds
//   (space-model.ts), which the kernel keeps only while that turn runs.
//
// ACP's one finished transport is stdio: an editor starts the agent as a
// program and they write lines to each other. `extensible-app acp <address>`
// (scripts/acp-bridge.mjs) is that program, and this is what it talks to. The
// shape follows ACP's draft for a remote transport (Streamable HTTP): the
// client POSTs each message; `initialize` is answered there, with an
// Acp-Connection-Id to send from then on; everything else the agent says
// (answers, session/update, session/request_permission) comes on the event
// stream the client opens with GET. It isn't that draft exactly, which is
// still changing: there is one stream for a connection, not one for each
// session, and a POST of a prompt is held open until the turn is over (which
// keeps the space's server awake for it), then answered 202 like the rest.
//
// The stream is kept by the host (mcpStream), which asks the door what there
// is to send only when the kernel says there is something. Each event's id is
// the message's number, and a stream opened with Last-Event-ID is sent what
// came after it, so a connection that drops loses nothing.

import { mcpStream, type Watch } from "./mcp.ts";
import type { RouteRequest, RouteResponse } from "./routes.ts";

/** How long the host waits for a turn: an agent's steps, each a model request, and the person's answers to its reviews. */
export const ACP_TURN_MS = 30 * 60_000;
/** How long it waits for anything else. */
export const ACP_TIMEOUT_MS = 60_000;
const MAX_BODY = 1024 * 1024;
const AGENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONNECTION = /^[0-9a-f]{32}$/;

/** The space and agent of an ACP address, or undefined for any other. */
export function acpAddress(url: URL): { space: string; agent: string } | undefined {
  const match = /^\/s\/([^/]+)\/acp\/([^/]+)\/?$/.exec(url.pathname);
  return match && AGENT.test(match[2]) ? { space: match[1], agent: match[2] } : undefined;
}

/** What a key for an editor is limited to (auth/agent-keys.ts `only`): this agent's address. */
export const editorKey = (agent: string) => `acp/${agent}`;

const answer = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "cache-control": "no-store", ...headers } });

const rpcError = (status: number, message: string, headers: Record<string, string> = {}) => answer(status, { jsonrpc: "2.0", id: null, error: { code: -32000, message } }, headers);

/** What a host gives: who a key is for, their name, and what unlocks the space's model key. */
export interface AcpHost {
  member(authorization: string | null, space: string, only: string): Promise<{ user: string; expires?: number; only?: string } | null>;
  /** The name on a member's account, for the space's model to count what they asked under. */
  name(space: string, user: string): Promise<string | undefined>;
  lock(space: string): Promise<string>;
  gateways?: Record<string, string>;
}

/**
 * Everything the host does before the kernel sees an ACP request: the method, the origin, the key and the
 * body. Gives the kernel's request, or the response to send instead.
 */
export async function acpRequest(request: Request, at: { space: string; agent: string }, host: AcpHost): Promise<RouteRequest | Response> {
  const url = new URL(request.url);
  // A page on another site may not call it from someone's browser; an editor sends no Origin.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return rpcError(403, "Not from this site");
  if (request.method !== "POST" && request.method !== "DELETE" && request.method !== "GET") return answer(405, undefined, { allow: "GET, POST, DELETE" });
  const who = await host.member(request.headers.get("authorization"), at.space, editorKey(at.agent)).catch(() => null);
  if (!who)
    return rpcError(
      401,
      "This needs an agent key for the space. Make one on /account/ (Agent keys), and give it to the editor as EXTENSIBLE_APP_KEY. A key made for another agent, or for an MCP client that signed in, doesn't open this one.",
      { "www-authenticate": 'Bearer realm="space"' },
    );
  const connection = request.headers.get("acp-connection-id") ?? "";
  if (connection && !CONNECTION.test(connection)) return rpcError(400, "That isn't a connection this server gave");
  const path = `/acp/${at.agent}`;
  if (request.method === "DELETE") {
    if (!connection) return rpcError(400, "DELETE ends a connection: send its Acp-Connection-Id");
    return { method: "DELETE", path, door: "acp", member: who.user, query: { connection } };
  }
  if (request.method === "GET") {
    if (!/\btext\/event-stream\b/i.test(request.headers.get("accept") ?? "")) return rpcError(406, "The stream is an event stream: Accept: text/event-stream");
    if (!connection) return rpcError(400, "Connect first (initialize), then open the stream with the Acp-Connection-Id you were given");
    const after = request.headers.get("last-event-id") ?? "";
    return { method: "GET", path, door: "acp", member: who.user, query: { connection, stream: randomHex(), after: /^\d{1,17}$/.test(after) ? after : "0" } };
  }
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return rpcError(415, "Send the message as JSON: Content-Type: application/json");
  const text = await readText(request);
  if (text === null) return rpcError(413, "That's more than this server reads at once (1 MB). Send less, or a part of the file.");
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return answer(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Not JSON" } });
  }
  // ACP has no batches (and the door would take a list for one message).
  if (Array.isArray(message)) return answer(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "One message at a time: ACP has no batches" } });
  const prompt = (message as { method?: unknown } | null)?.method === "session/prompt";
  return {
    method: "POST",
    path,
    door: "acp",
    member: who.user,
    query: { connection },
    form: {
      message,
      name: (await host.name(at.space, who.user).catch(() => undefined)) ?? "A member",
      // Only a key made for this editor and agent lets the editor answer the agent's reviews.
      answers: who.only === editorKey(at.agent),
      // What unlocks the space's model key goes in only with a prompt, which is what asks the model.
      ...(prompt ? { lock: await host.lock(at.space), ...(host.gateways && Object.keys(host.gateways).length ? { gateways: host.gateways } : {}) } : {}),
    },
  };
}

/** How long the host should wait for the kernel's answer to a request acpRequest made. */
export const acpWait = (asked: RouteRequest) => ((asked.form as { lock?: unknown } | undefined)?.lock !== undefined ? ACP_TURN_MS : ACP_TIMEOUT_MS);

/** What the door (std/acp/door.ts) answers in `json`: a JSON-RPC answer to send now, and the connection it made. */
interface AcpAnswer {
  reply?: unknown;
  connection?: string;
}

/** The kernel's answer as an HTTP response. */
export function acpResponse(result: RouteResponse | null): Response {
  if (!result) return rpcError(501, "This site has no agents an editor can talk to (its kernel has no acp module)");
  const status = Number.isInteger(result.status) ? result.status! : 200;
  if ("json" in result) {
    const { reply, connection } = (result.json ?? {}) as AcpAnswer;
    return answer(status, reply, connection ? { "acp-connection-id": connection } : {});
  }
  if (status === 200 || status === 202) return answer(202);
  return rpcError(status, typeof result.text === "string" && result.text ? result.text : "The space couldn't answer");
}

/**
 * An editor's GET stream, kept open by the host as an MCP client's is (mcpStream): asked once as it opens, and
 * after that only when the kernel says there is something to send. Each event's id is the message's number, and
 * the door is asked for what came after the last one sent.
 */
export function acpStream(asked: RouteRequest, ask: (request: RouteRequest) => Promise<RouteResponse | null>, watch: Watch, key: () => Promise<{ expires?: number } | null>): Promise<Response> {
  let after = asked.query?.after ?? "0";
  return mcpStream(asked, ask, watch, {
    key,
    frame: (notice) => {
      const { seq, message } = notice as { seq: number; message: unknown };
      after = String(seq);
      return { id: after, data: message };
    },
    query: () => ({ after }),
  });
}

const randomHex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

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
