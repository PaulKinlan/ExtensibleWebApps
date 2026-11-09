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
// This is MCP's Streamable HTTP transport without the streaming: each POST is
// answered with JSON, and there is no GET stream or session to end, which is
// all a server that only has tools needs.

import type { RouteRequest, RouteResponse } from "./routes.ts";

/** How long the host waits for the kernel's answer: long enough for a person to answer a review. */
export const MCP_TIMEOUT_MS = 120_000;
const MAX_BODY = 256 * 1024;
const PLUGIN = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
  member: (authorization: string | null, space: string) => Promise<{ user: string } | null>,
): Promise<RouteRequest | Response> {
  const url = new URL(request.url);
  // A page on another site may not call it from someone's browser (MCP's advice against DNS rebinding);
  // an agent that isn't a browser sends no Origin.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return rpcError(403, "Not from this site");
  if (request.method !== "POST") return answer(405, undefined, { allow: "POST" });
  const who = await member(request.headers.get("authorization"), at.space).catch(() => null);
  if (!who) return rpcError(401, "This needs an agent key for the space: make one on /account/ and send it as Authorization: Bearer <key>", { "www-authenticate": 'Bearer realm="space"' });
  const text = await readText(request);
  if (text === null) return rpcError(413, "That's more than this server reads");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return answer(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Not JSON" } });
  }
  return { method: "POST", path: `/mcp/${at.plugin}`, door: "mcp", member: who.user, form: body };
}

/** The kernel's answer as an HTTP response. */
export function mcpResponse(result: RouteResponse | null): Response {
  if (!result) return rpcError(503, "The space didn't answer");
  const status = Number.isInteger(result.status) ? result.status! : 200;
  if (status === 202 || !("json" in result)) return answer(status === 200 ? 202 : status);
  return answer(status, result.json);
}

async function readText(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  const buffer = await request.arrayBuffer();
  return buffer.byteLength > MAX_BODY ? null : new TextDecoder().decode(buffer);
}
