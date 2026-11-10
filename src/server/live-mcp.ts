// Live MCP relay: lets a person share an MCP URL (/mcp/live/<channel>/<token>)
// from an open browser tab and securely connect an external MCP client (Claude
// Code, Cursor, Inspector…) directly to the live browser instance they are
// looking at right now—without needing an account or a space.
//
// The browser tab opens a WebSocket to /mcp/live/<channel>/bridge and registers
// only the SHA-256 hex digest of its secret token. The server never stores
// persistent state and never sees the plaintext token until a client presents
// it; requests with a wrong or missing token are refused with 401 before
// reaching the browser. Closing the tab (or clicking Disconnect) closes the
// bridge socket and invalidates the URL at once.

import { MCP_TIMEOUT_MS, mcpResponse, mcpStream, type Watch } from "./mcp.ts";
import type { RouteRequest, RouteResponse } from "./routes.ts";

const MAX_BODY = 256 * 1024;
const SESSION = /^[0-9a-f]{32}$/;
const HEX_HASH = /^[0-9a-f]{64}$/;
const MAX_CHANNELS = 500;

export interface BridgeSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

interface PendingAsk {
  resolve: (res: RouteResponse | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Channel {
  socket: BridgeSocket;
  hash?: string;
  nextId: number;
  pending: Map<number, PendingAsk>;
  watchers: Set<{ wake(): void; lost(): void }>;
  createdAt: number;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const rpcJson = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

async function readTextBounded(request: Request): Promise<string | null> {
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

const randomHex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function createLiveMcpRelay() {
  const channels = new Map<string, Channel>();

  function drop(id: string, target?: Channel) {
    const ch = channels.get(id);
    if (!ch || (target && ch !== target)) return;
    channels.delete(id);
    for (const [, p] of ch.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    ch.pending.clear();
    for (const w of [...ch.watchers]) w.lost();
    ch.watchers.clear();
  }

  return {
    /** Attaches the open browser tab's WebSocket for `channel`; returns `{ message, close }` handlers. */
    attach(channel: string, socket: BridgeSocket) {
      const prev = channels.get(channel);
      if (prev) {
        drop(channel, prev);
        try {
          prev.socket.close(1012, "Replaced");
        } catch {}
      }
      if (channels.size >= MAX_CHANNELS) {
        const oldest = [...channels.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
        if (oldest) {
          drop(oldest[0], oldest[1]);
          try {
            oldest[1].socket.close(1001, "Too many live channels");
          } catch {}
        }
      }
      const state: Channel = { socket, nextId: 0, pending: new Map(), watchers: new Set(), createdAt: Date.now() };
      channels.set(channel, state);

      return {
        message(raw: string) {
          let msg: { t?: string; hash?: unknown; id?: unknown; status?: unknown; json?: unknown };
          try {
            msg = JSON.parse(raw);
          } catch {
            return;
          }
          if (msg?.t === "hello" && typeof msg.hash === "string" && HEX_HASH.test(msg.hash)) {
            state.hash = msg.hash;
            try {
              socket.send(JSON.stringify({ t: "ready" }));
            } catch {}
            return;
          }
          if (msg?.t === "changed") {
            for (const w of [...state.watchers]) w.wake();
            return;
          }
          if (msg?.t === "mcp:reply" && typeof msg.id === "number") {
            const p = state.pending.get(msg.id);
            if (!p) return;
            state.pending.delete(msg.id);
            clearTimeout(p.timer);
            p.resolve({
              status: typeof msg.status === "number" ? msg.status : 200,
              ...(msg.json !== undefined ? { json: msg.json } : {}),
            });
          }
        },
        close() {
          drop(channel, state);
        },
      };
    },

    /** Handles an HTTP MCP request (`POST`, `GET` SSE stream, or `DELETE`) for `channel`. */
    async handle(request: Request, channel: string, urlToken?: string): Promise<Response> {
      const state = channels.get(channel);
      if (!state || !state.hash) return rpcJson(404, "That live tab isn't connected right now (its tab may have closed, or disconnected)");
      const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      const token = urlToken || bearer || "";
      if (!token || !timingSafeEqualHex(await sha256Hex(token), state.hash)) {
        return rpcJson(401, "This live MCP address needs the secret token from the tab that shared it");
      }
      if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
        return new Response(null, { status: 405, headers: { allow: "GET, POST, DELETE" } });
      }
      const session = request.headers.get("mcp-session-id") ?? "";
      if (session && !SESSION.test(session)) return rpcJson(400, "That isn't a session this tab gave");
      const streams = /\btext\/event-stream\b/i.test(request.headers.get("accept") ?? "") ? "1" : "";

      const askTab = (req: RouteRequest, timeout = MCP_TIMEOUT_MS): Promise<RouteResponse | null> => {
        if (channels.get(channel) !== state) return Promise.resolve(null);
        const id = ++state.nextId;
        return new Promise<RouteResponse | null>((resolve) => {
          const timer = setTimeout(() => {
            state.pending.delete(id);
            resolve({ status: 504, text: "The open tab didn't answer in time" });
          }, timeout);
          state.pending.set(id, { resolve, timer });
          try {
            state.socket.send(JSON.stringify({ t: "mcp", id, request: req }));
          } catch {
            clearTimeout(timer);
            state.pending.delete(id);
            resolve(null);
          }
        });
      };

      if (request.method === "DELETE") {
        return mcpResponse(await askTab({ method: "DELETE", path: "/mcp/live", door: "mcp", query: { session, streams } }, 15_000));
      }
      if (request.method === "GET") {
        if (!streams) return rpcJson(406, "The stream is an event stream: Accept: text/event-stream");
        if (!session) return rpcJson(400, "Connect first (initialize), then open the stream with the Mcp-Session-Id you were given");
        const watch: Watch = (wake, lost) => {
          const w = { wake, lost };
          state.watchers.add(w);
          return () => state.watchers.delete(w);
        };
        return mcpStream(
          { method: "GET", path: "/mcp/live", door: "mcp", query: { session, stream: randomHex() } },
          (knock) => askTab(knock, 15_000),
          watch,
          { key: async () => (channels.get(channel) === state && state.hash ? {} : null) },
        );
      }

      const text = await readTextBounded(request);
      if (text === null) return rpcJson(413, "That's more than this relay reads");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Not JSON" } }), {
          status: 400,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      return mcpResponse(await askTab({ method: "POST", path: "/mcp/live", door: "mcp", form: body, query: { session, streams } }));
    },
  };
}
