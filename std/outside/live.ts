// Live browser-tab MCP pairing for `std/outside`: lets the person share an MCP
// URL (/mcp/live/<channel>/<token>) from an open browser tab and connect an
// external MCP client (Claude Code, Cursor, MCP Inspector…) directly to the
// exact live browser instance they are looking at right now—with no account or
// space server needed.
//
// Security model:
// 1. Only a hash (SHA-256 hex) of the 192-bit secret token is sent over the
//    tab's bridge WebSocket (/mcp/live/<channel>/bridge); the relay rejects
//    unauthenticated HTTP knocks with 401 before reaching the browser.
// 2. When an external MCP client sends `initialize`, the person is asked once
//    on a review card in that tab (`once: true`) naming the client before any
//    `Mcp-Session-Id` is issued.
// 3. Every authoring change (`authoring_save`, `authoring_saveComponent`,
//    `authoring_remove`, …) and every collection write (`data_put_*`,
//    `data_delete_*`) runs as `live-mcp@<tab>`, so the person reviews every
//    plugin diff, custom `ui-*` element and record change on screen.
// 4. Closing the tab (`internal/left`) or clicking Disconnect closes the
//    bridge WebSocket and invalidates the URL immediately.

import { env } from "../../src/kernel/env";
import { grants } from "../../src/kernel/gate";
import { hooks } from "../../src/kernel/hooks";
import type { Host } from "../../src/kernel/hosts";
import type { ModuleKernel } from "../../src/kernel/modules";
import { callService, type MethodDoc, type Param } from "../../src/kernel/remote";
import { allowed } from "../../src/kernel/review";
import { validate, type Schema } from "../../src/kernel/schema";
import { record } from "../../src/kernel/trace";
import type { RouteRequest, RouteResponse } from "../../src/kernel/routes";
import type { Tool } from "../tools/module";
import { CALLS_PER_HOUR, MCP_VERSION, REVIEW_WAIT_MS, type McpAnswer } from "./module";

const SESSION_ID = /^[0-9a-f]{32}$/;
const MAX_SESSIONS = 32;
const PER_NAME = 5;

/** Capabilities a paired live MCP client may exercise on the tab (all mutating calls still go through on-screen review). */
const LIVE_CAPS = new Set([
  "plugins:read",
  "plugins:author",
  "plugins:manage",
  "commands",
  "data:read:*",
  "data:write:*",
  "history",
]);

/** Services exposed to a paired live MCP client on the tab. */
const LIVE_SERVICES = new Set(["authoring", "plugins", "commands", "data", "history"]);

type Collection = { name: string; owner: string; title?: string; schema: Schema };
type Entry = { tool: Tool; params: Param[]; fixed: Record<string, unknown>; records: Set<string>; doorCall?: (args: unknown, dispatch: { trace?: string }) => Promise<unknown> };

interface LiveSession {
  client: string;
  seen?: string;
  used: number;
  stream?: string;
}

interface LiveConnection {
  tab: string;
  channel: string;
  url: string;
  socket: WebSocket;
  sessions: Map<string, LiveSession>;
  ended: Set<string>;
  clients: string[];
  calls: number[];
  closed: boolean;
}

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? null));

const randomHex = (bytes = 16) => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const randomToken = () => {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  let binary = "";
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const fingerprint = (tools: Tool[]) => {
  const text = JSON.stringify(tools.map((t) => [t.name, t.description, t.parameters]));
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${tools.length}-${(h >>> 0).toString(36)}`;
};

const isReadOnly = (tool: Tool) =>
  !tool.reviewed && /^(get|list|collections|hooks|read|search|current|reference|page|layout|mine|packages|file|check|components|app|providers|status|liveStatus)$/.test(tool.method);

function mayNeed(caps: Set<string>, needs: string): boolean {
  if (!needs.includes("<")) return grants(caps, needs);
  const prefix = needs.split("<")[0];
  for (const cap of caps) if (cap.startsWith(prefix) || (cap.endsWith("*") && prefix.startsWith(cap.slice(0, -1)))) return true;
  return false;
}

const recordSchema = (collection: Collection): Schema => ({
  ...collection.schema,
  type: "object",
  description: `A record of ${collection.title ?? collection.name}; include its id to replace an existing record`,
  properties: { id: { type: "string", description: "The record to replace; leave out for a new one" }, ...(collection.schema.properties ?? {}) },
});

const instructionsFor = (app?: string) =>
  [
    `You are connected live to an open Extensible Web Apps browser tab${app ? ` (${app})` : ""}.`,
    `What you do happens in the exact page the person is looking at right now, and every plugin, custom ui-* component or data write shows a review card on their screen before taking effect.`,
    `- Call authoring_layout and authoring_page first to see the page's slots, named parts, existing ui-* elements and running plugins.`,
    `- To create a reusable custom UI element (such as <ui-metric-pill>), call authoring_saveComponent with its tag and HTML (<style> + markup with {{attr}} holes and <slot>). Views can use it right away.`,
    `- To create or update a plugin, call authoring_check and then authoring_save with code (export const manifest = { ... } first, plain ES module) and optional template files ({ "view.html": "<template id=...>...</template>" }).`,
    `- Prefer slots from authoring_layout, or places: { here: { at: "<selector>", put: "after" } } for pages without a matching slot.`,
  ].join("\n");

export function createLiveTabMcp(
  kernel: ModuleKernel,
  extraTabTools: (tab: string, dispatch: { trace?: string }) => Promise<Entry[]>,
) {
  const { root, hosts, remote, reviews, appIn, whole } = kernel;
  const active = new Map<string, LiveConnection>();

  const tabFrom = (instance: string): string => {
    const [, tab] = instance.split("@");
    const target = tab || (hosts.list.length === 1 ? hosts.list[0].tab : "");
    if (!target || !hosts.list.some((h) => h.tab === target)) throw new Error("Open this from a browser tab");
    return target;
  };

  async function entriesFor(tab: string, dispatch: { trace?: string }): Promise<Entry[]> {
    const caller = `live-mcp@${tab}`;
    await whole();
    const collections = new Map<string, Collection>();
    if (remote.services.data) {
      for (const c of ((await remote.services.data.call(caller, "collections", [], dispatch)) ?? []) as Collection[]) {
        collections.set(c.name, c);
      }
    }
    const entries: Entry[] = [];
    for (const [service, provider] of Object.entries(remote.services)) {
      if (!LIVE_SERVICES.has(service)) continue;
      for (const [method, doc] of Object.entries(provider.methods) as [string, MethodDoc][]) {
        if (!doc.params) continue;
        const review = doc.reviewed ? " The person reviews this on screen first, so give a clear reason where asked." : "";
        const add = (name: string, params: Param[], fixed: Record<string, unknown>, about = "") => {
          const properties: Record<string, Schema> = {};
          const records = new Set<string>();
          for (const param of params) {
            if (Object.hasOwn(fixed, param.name)) continue;
            const of = param.recordOf && fixed[param.recordOf];
            if (typeof of === "string" && collections.has(of)) records.add(param.name);
            properties[param.name] = records.has(param.name) ? recordSchema(collections.get(of as string)!) : { ...param.schema };
          }
          const required = params.filter((p) => !p.optional && !Object.hasOwn(fixed, p.name)).map((p) => p.name);
          const tool: Tool = {
            name,
            description: `${about}${doc.description} Returns ${doc.returns}.${review}`,
            parameters: { type: "object", properties, required, additionalProperties: false },
            service,
            method,
            reviewed: !!doc.reviewed,
          };
          entries.push({ tool, params, fixed, records });
        };
        const named = doc.params.filter((p) => p.names);
        if (!named.length) {
          if (!doc.needs || mayNeed(LIVE_CAPS, doc.needs)) add(`${service}_${method}`, doc.params, {});
          continue;
        }
        const names = [...collections.keys()].sort();
        if (!names.length) continue;
        const [only] = named;
        if (named.length === 1 && names.length <= PER_NAME && names.every((n) => `${service}_${method}_${n}`.length <= 64)) {
          for (const n of names) add(`${service}_${method}_${n}`, doc.params, { [only.name]: n }, `For ${collections.get(n)?.title ?? n} (${only.name} ${n}). `);
          continue;
        }
        add(
          `${service}_${method}`,
          doc.params.map((p) => (p.names ? { ...p, schema: { ...p.schema, enum: names } } : p)),
          {},
        );
      }
    }
    const seen = new Set(entries.map((e) => e.tool.name));
    for (const extra of await extraTabTools(tab, dispatch)) {
      if (!seen.has(extra.tool.name)) {
        seen.add(extra.tool.name);
        entries.push(extra);
      }
    }
    return entries;
  }

  async function invokeTool(conn: LiveConnection, name: string, input: unknown, dispatch: { trace?: string }): Promise<unknown> {
    const now = Date.now();
    conn.calls = conn.calls.filter((at) => now - at < 3_600_000);
    if (conn.calls.length >= CALLS_PER_HOUR) throw new Error(`Live MCP clients may call ${CALLS_PER_HOUR} tools an hour on this tab; try again later`);
    conn.calls.push(now);

    const entry = (await entriesFor(conn.tab, dispatch)).find((e) => e.tool.name === name);
    if (!entry) throw new Error(`No tool named ${name}`);

    if (hooks.has("agent:beforeTool")) {
      const verdict = await root.serial(dispatch, "agent:beforeTool", { agent: "live-mcp", run: dispatch.trace ?? "live-mcp", tool: name, args: input ?? {}, chain: ["live-mcp"] });
      if (isObject(verdict) && "block" in verdict) throw new Error(`Blocked: ${String(verdict.block)}`);
    }

    let ok = false;
    try {
      if (entry.doorCall) {
        const value = await entry.doorCall(input ?? {}, dispatch);
        ok = true;
        return value;
      }
      const { tool } = entry;
      const given = input ?? {};
      if (!isObject(given)) throw new Error(`${tool.name} takes its arguments as an object`);
      const unknown = Object.keys(given).filter((key) => !Object.hasOwn(tool.parameters.properties, key));
      if (unknown.length) throw new Error(`${tool.name} has no argument ${unknown.join(", ")}`);
      const missing = tool.parameters.required.filter((key) => !Object.hasOwn(given, key) || given[key] === undefined);
      if (missing.length) throw new Error(`${tool.name}: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required`);
      const cleared = (value: unknown) => (isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== "")) : value);
      const errors = Object.entries(given).flatMap(([key, value]) =>
        entry.records.has(key) ? validate(tool.parameters.properties[key], cleared(value), key) : validate(tool.parameters.properties[key], value, key, true),
      );
      if (errors.length) throw new Error(`${tool.name}: ${errors.map((e) => e.message).join("; ")}`);
      const positional = entry.params.map((p) => (Object.hasOwn(entry.fixed, p.name) ? entry.fixed[p.name] : given[p.name]));
      while (positional.length && positional.at(-1) === undefined) positional.pop();
      const value = await callService(remote.services, `live-mcp@${conn.tab}`, LIVE_CAPS, tool.service, tool.method, positional, dispatch);
      ok = true;
      return value;
    } finally {
      root.emit(dispatch, "outside:called", { plugin: "live-mcp", tool: name, via: "mcp", ok });
    }
  }

  function notifyChanged(conn: LiveConnection) {
    if (conn.closed || conn.socket.readyState !== WebSocket.OPEN) return;
    try {
      conn.socket.send(JSON.stringify({ t: "changed" }));
    } catch {}
  }

  async function handleMcp(conn: LiveConnection, request: RouteRequest): Promise<RouteResponse> {
    const method = request.method ?? "POST";
    const sessionId = request.query?.session || undefined;
    const streams = request.query?.streams === "1";
    const stream = request.query?.stream || undefined;
    const first = request.query?.first === "1";

    const session = sessionId
      ? !SESSION_ID.test(sessionId) || conn.ended.has(sessionId)
        ? null
        : conn.sessions.get(sessionId) ?? null
      : undefined;

    if (session === null) {
      return { status: 404, json: { reply: { jsonrpc: "2.0", id: null, error: { code: -32001, message: "That live MCP session isn't active on this tab: initialize again" } } } };
    }

    if (method === "DELETE") {
      if (!sessionId) return { status: 400, json: { reply: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "DELETE ends a session: send its Mcp-Session-Id" } } } };
      conn.sessions.delete(sessionId);
      conn.ended.add(sessionId);
      notifyChanged(conn);
      return { status: 200 };
    }

    if (method === "GET") {
      if (!session || !stream) return { status: 400, json: { reply: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "A stream needs a session: initialize first" } } } };
      if (first) {
        if (session.stream && session.stream !== stream) notifyChanged(conn);
        session.stream = stream;
      } else if (!session.stream) {
        session.stream = stream;
      } else if (session.stream !== stream) {
        return { status: 409, json: { reply: { jsonrpc: "2.0", id: null, error: { code: -32000, message: "A newer stream for this session took over" } } } };
      }
      session.used = Date.now();
      const tools = (await entriesFor(conn.tab, { trace: "live-mcp:stream" }).catch(() => [])).map((e) => e.tool);
      const now = fingerprint(tools);
      const json: McpAnswer = {};
      if (session.seen !== now) json.notices = [{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }];
      session.seen = now;
      return { status: 200, json };
    }

    let started: string | undefined;
    const one = async (rpc: Rpc): Promise<unknown> => {
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id: rpc.id ?? null, result });
      const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message } });
      if (!rpc || typeof rpc !== "object" || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return fail(-32600, "Not a JSON-RPC 2.0 request");
      if (rpc.id === undefined) return undefined;
      const dispatch = { trace: `live-mcp-${randomHex(4)}` };

      switch (rpc.method) {
        case "initialize": {
          const info = isObject(rpc.params?.clientInfo) ? rpc.params.clientInfo : {};
          const client = typeof info.name === "string" && info.name.trim() ? info.name.trim().slice(0, 64) : "External MCP client";
          const app = appIn(conn.tab);
          const outcome = await reviews.ask(
            {
              plugin: "live-mcp",
              instance: `live-mcp@${conn.tab}`,
              name: client,
              place: "live:mcp",
              target: "live MCP access to this tab",
              before: "Disconnected",
              after: [
                `Connected client: ${client}`,
                `Tab app: ${app ?? "current page"}`,
                `Allowed to inspect layout, plugins, custom ui-* elements, commands and collections.`,
                `Creating or changing plugins, components or records will still ask you on a review card.`,
              ].join("\n"),
              reason: "An MCP client opened your shared link to connect to the live page on your screen.",
              once: true,
            },
            dispatch,
          );
          if (!allowed(outcome)) return fail(-32001, "The person declined the live MCP connection on their screen");

          const tools = (await entriesFor(conn.tab, dispatch)).map((e) => e.tool);
          if (conn.sessions.size >= MAX_SESSIONS) {
            const oldest = [...conn.sessions.entries()].sort((a, b) => a[1].used - b[1].used)[0];
            if (oldest) conn.sessions.delete(oldest[0]);
          }
          started = randomHex(16);
          conn.sessions.set(started, { client, seen: fingerprint(tools), used: Date.now() });
          if (!conn.clients.includes(client)) {
            conn.clients.push(client);
            root.emit(dispatch, "plugins:changed");
          }
          record({ kind: "note", name: "outside:live-connected", plugin: `live-mcp@${conn.tab}`, trace: dispatch.trace, detail: client });
          return reply({
            protocolVersion: MCP_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: app ? `Live tab (${app})` : "Live browser tab", version: "1.0.0" },
            instructions: instructionsFor(app),
          });
        }
        case "ping":
          if (!session) return fail(-32001, "Connect with initialize first, and send Mcp-Session-Id");
          session.used = Date.now();
          return reply({});
        case "tools/list": {
          if (!session) return fail(-32001, "Connect with initialize first, and send Mcp-Session-Id");
          session.used = Date.now();
          const tools = (await entriesFor(conn.tab, dispatch)).map((e) => e.tool);
          session.seen = fingerprint(tools);
          return reply({
            tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters, annotations: { readOnlyHint: isReadOnly(t) } })),
          });
        }
        case "tools/call": {
          if (!session) return fail(-32001, "Connect with initialize first, and send Mcp-Session-Id");
          session.used = Date.now();
          const name = rpc.params?.name;
          if (typeof name !== "string") return fail(-32602, "tools/call needs the tool's name");
          let timer: ReturnType<typeof setTimeout> | undefined;
          const waiting = new Promise<never>(
            (_, late) =>
              (timer = setTimeout(
                () => late(new Error("The person hasn't answered the review card on their screen yet; ask them or try again shortly.")),
                REVIEW_WAIT_MS,
              )),
          );
          try {
            const value = await Promise.race([invokeTool(conn, name, rpc.params?.arguments, dispatch), waiting]);
            return reply({ content: [{ type: "text", text: asText(value) }], isError: false });
          } catch (error) {
            return reply({ content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }], isError: true });
          } finally {
            clearTimeout(timer);
          }
        }
        default:
          return fail(-32601, `This live tab MCP server has no method ${rpc.method}`);
      }
    };

    const body = request.form;
    const messages = Array.isArray(body) ? body.slice(0, 20) : [body];
    const answers = (await Promise.all(messages.map((m) => one(m as Rpc)))).filter((a) => a !== undefined);
    if (!answers.length) return { status: 202 };
    const json: McpAnswer = { reply: Array.isArray(body) ? answers : answers[0] };
    if (started) json.session = started;
    if (session && streams && !answers.some((a) => (a as { result?: { tools?: unknown } })?.result?.tools)) {
      const now = fingerprint((await entriesFor(conn.tab, { trace: "live-mcp:changed" }).catch(() => [])).map((e) => e.tool));
      if (session.seen !== now) json.notices = [{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }];
      session.seen = now;
    }
    return { status: 200, json };
  }

  function closeTab(tab: string) {
    const conn = active.get(tab);
    if (!conn) return;
    conn.closed = true;
    active.delete(tab);
    reviews.cancelInstance(`live-mcp@${tab}`);
    try {
      conn.socket.close(1000, "Disconnected");
    } catch {}
  }

  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  const broadcastChanged = () => {
    if (!active.size) return;
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      for (const conn of active.values()) notifyChanged(conn);
    }, 250);
  };

  root.on("plugins:changed", broadcastChanged);
  root.on("internal/started", broadcastChanged);
  root.on("internal/stopped", broadcastChanged);
  root.on("internal/left", (host: Host) => closeTab(host.tab));

  return {
    status(instance: string) {
      if (hosts.mode === "server") return { open: false, clients: [] as string[] };
      const tab = tabFrom(instance);
      const conn = active.get(tab);
      if (!conn || conn.closed || conn.socket.readyState !== WebSocket.OPEN) return { open: false, clients: [] as string[] };
      return { open: true, url: conn.url, clients: [...conn.clients] };
    },

    async open(instance: string, options: { rotate?: boolean } = {}) {
      if (hosts.mode === "server") throw new Error("Live tab MCP links are opened from a browser tab; on a space's server, use /s/<space>/mcp/<plugin>");
      const tab = tabFrom(instance);
      const existing = active.get(tab);
      if (existing && !existing.closed && existing.socket.readyState === WebSocket.OPEN && !options.rotate) {
        return { ok: true, open: true, url: existing.url, clients: [...existing.clients] };
      }
      closeTab(tab);

      const origin = env().origin;
      if (!origin || !/^https?:\/\//.test(origin)) throw new Error("This page has no HTTP address an MCP client can reach");
      const channel = randomHex(16);
      const token = randomToken();
      const hash = await sha256Hex(token);
      const wsOrigin = origin.replace(/^http/, "ws");
      const socket = new WebSocket(`${wsOrigin}/mcp/live/${channel}/bridge`);
      const url = `${origin}/mcp/live/${channel}/${token}`;

      const conn: LiveConnection = {
        tab,
        channel,
        url,
        socket,
        sessions: new Map(),
        ended: new Set(),
        clients: [],
        calls: [],
        closed: false,
      };

      await new Promise<void>((ready, fail) => {
        const timer = setTimeout(() => {
          try {
            socket.close();
          } catch {}
          fail(new Error("Couldn't connect the live MCP relay on this server"));
        }, 10_000);

        const onFirstMessage = (event: MessageEvent) => {
          let msg: { t?: string; id?: unknown; request?: RouteRequest };
          try {
            msg = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (msg?.t === "ready") {
            clearTimeout(timer);
            ready();
            return;
          }
          if (msg?.t === "mcp" && typeof msg.id === "number" && msg.request) {
            const reqId = msg.id;
            void handleMcp(conn, msg.request)
              .then((res) => {
                if (!conn.closed && socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ t: "mcp:reply", id: reqId, status: res.status, ...(res.json !== undefined ? { json: res.json } : {}) }));
                }
              })
              .catch((err) => {
                if (!conn.closed && socket.readyState === WebSocket.OPEN) {
                  socket.send(
                    JSON.stringify({
                      t: "mcp:reply",
                      id: reqId,
                      status: 500,
                      json: { reply: { jsonrpc: "2.0", id: null, error: { code: -32603, message: String(err instanceof Error ? err.message : err) } } },
                    }),
                  );
                }
              });
          }
        };

        socket.addEventListener("open", () => {
          try {
            socket.send(JSON.stringify({ t: "hello", hash }));
          } catch (err) {
            clearTimeout(timer);
            fail(err);
          }
        });
        socket.addEventListener("message", onFirstMessage);
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          fail(new Error("This server doesn't accept live MCP connections"));
        });
        socket.addEventListener("close", () => {
          clearTimeout(timer);
          if (active.get(tab) === conn) closeTab(tab);
          fail(new Error("The live MCP connection closed"));
        });
      });

      active.set(tab, conn);
      record({ kind: "note", name: "outside:live-open", plugin: instance, detail: channel.slice(0, 8) });
      return { ok: true, open: true, url, clients: [] as string[] };
    },

    close(instance: string) {
      if (hosts.mode === "server") return { ok: true };
      const tab = tabFrom(instance);
      closeTab(tab);
      return { ok: true };
    },

    cleanup() {
      clearTimeout(broadcastTimer);
      for (const tab of [...active.keys()]) closeTab(tab);
    },
  };
}
