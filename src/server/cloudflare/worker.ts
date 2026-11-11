// The platform on Cloudflare: the built site as static assets, and a kernel
// for each space a client joins, at wss://<host>/s/<space>/kernel, as the Node
// host does (src/server/serve.ts).
//
// Each space is a Durable Object, `Space`, found by the space's name. It is
// the space's supervisor: it holds the clients' WebSockets and runs the
// space's kernel (kernel.ts, built into .build/cloudflare/) as a Dynamic
// Worker of its own, as a facet with its own SQLite database for the space's
// folder.
//
// Accounts and sign-in (/auth/, src/server/auth/accounts.ts) are one more
// Durable Object, `Accounts`, whose SQLite database holds every account.
//
// Only a space's members may join it, which `Accounts` decides from the
// request's session cookie.
//
// A space's server plugins (runs: "server" in their manifest) each run as a
// Dynamic Worker of their own (isolate.ts, built into .build/cloudflare/), as
// another facet of the space: with no outbound network unless the plugin has
// `network`, nothing in their env, and no storage of the space's. The kernel
// reaches them through the supervisor (PluginHost, below).

import { DurableObject, RpcTarget } from "cloudflare:workers";
// The space kernel's built source, as text (npm run build:cloudflare writes it).
import kernelSource from "../../../.build/cloudflare/kernel-source.js";
// A plugin's sandbox, the same way.
import isolateSource from "../../../.build/cloudflare/isolate-source.js";
import { durableFiles, type Sql } from "../../seams/durable.ts";
import type { Message } from "../../seams/index.ts";
import { accounts } from "../auth/accounts.ts";
import { providersFrom } from "../auth/providers.ts";
import { providerModules } from "../auth/providers/index.ts";
import { type Decision, frontDoor, unrouted } from "../front-door.ts";
import { createLiveMcpRelay } from "../live-mcp.ts";
import { mcpAddress, mcpRequest, mcpResponse, mcpStream, type Watch } from "../mcp.ts";
import { type RouteRequest, type RouteResponse, routeRequest, routeResponse, tooLarge } from "../routes.ts";
import type { SpaceCopy } from "../space-copy.ts";
import { transferRoute } from "../transfer.ts";
import { gatewaysFrom, modelRoute } from "../space-model.ts";
import { feedReader } from "../feed-reader.ts";
import { isOwnNetwork, leadsInside } from "./network-guard.ts";
import { resolverFrom } from "./names.ts";
// Server plugins' way out to the network: an entrypoint of this Worker, so it is exported here.
export { NetworkGuard } from "./network-guard.ts";

/** A new kernel build gets a new isolate; spaces on the old one move over as they restart. */
const KERNEL_VERSION = kernelSource.version;

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SPACE: DurableObjectNamespace<Space>;
  ACCOUNTS: DurableObjectNamespace<Accounts>;
  LOADER: WorkerLoader;
  /** Cloudflare Email Service (the send_email binding), and the address mail comes from: both, or mail stays in the outbox. */
  EMAIL?: { send(message: { to: string[]; from: string; subject: string; text: string; html?: string }): Promise<{ messageId: string }> };
  EMAIL_FROM?: string;
  /** Private hosts server plugins may reach anyway, comma-separated, as on Node (network-guard.ts). For tests under wrangler dev. */
  ALLOW_PRIVATE_HOSTS?: string;
  /** Vendors' hosts a space's model key is used through a gateway for, as JSON (src/server/space-model.ts). */
  MODEL_GATEWAYS?: string;
  /** The DNS-over-HTTPS resolver that says where a name leads (names.ts), when not Cloudflare's. The server checks name a stand-in. */
  DNS_RESOLVER?: string;
}

interface KernelStub {
  join(client: string, origin: string, send: (text: string) => void, member?: string, host?: PluginHost): Promise<void>;
  deliver(client: string, text: string): Promise<void>;
  leave(client: string): Promise<void>;
  route(origin: string, request: RouteRequest, host?: PluginHost): Promise<RouteResponse | null>;
  tick(origin: string, host?: PluginHost): Promise<void>;
  dump(space: string): Promise<SpaceCopy>;
  load(copy: SpaceCopy): Promise<{ files: number }>;
}

type Send = ((message: unknown) => void) & { dup?: () => Send };
/** Lets go of a function kept from an RPC call (Symbol.dispose, which this file's ES2022 types don't name). */
const release = (kept: object | undefined) => (kept as Record<symbol, (() => void) | undefined> | undefined)?.[(Symbol as unknown as { dispose: symbol }).dispose]?.();

interface IsolateStub {
  start(source: string, network: boolean, send: Send): Promise<void>;
  deliver(message: unknown): Promise<void>;
}

const hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);

/**
 * What a space's kernel calls to run its server plugins, and to read the site's own files (an app's
 * app.html and plugins). Each plugin is a facet of the space, `plugin:<name>`, running isolate.ts with
 * the plugin's source beside it.
 */
class PluginHost extends RpcTarget {
  private running = new Map<string, { stub: IsolateStub; send: Send }>();

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
    private space: string,
  ) {
    super();
  }

  /** Each plugin's starts and stops, one at a time: a start that overlapped another would share its facet. */
  private turns = new Map<string, Promise<unknown>>();
  private inTurn<T>(name: string, work: () => Promise<T>): Promise<T> {
    const run = (this.turns.get(name) ?? Promise.resolve()).then(work, work);
    this.turns.set(name, run.catch(() => {}));
    return run;
  }

  start(name: string, source: string, network: boolean, send: Send): Promise<void> {
    // Kept now: a function passed over RPC lasts only as long as the call, and this one may wait its turn.
    const kept = send.dup?.() ?? send;
    return this.inTurn(name, () => this.starting(name, source, network, kept));
  }

  private async starting(name: string, source: string, network: boolean, kept: Send): Promise<void> {
    await this.stopping(name);
    const code = `plugin:${this.space}:${name}:${isolateSource.version}:${network ? "net" : "closed"}:${await hex(source)}`;
    const worker = this.env.LOADER.get(code, () => ({
      compatibilityDate: "2026-11-01",
      // Node's compatibility is on by default from this date: off, there are no node: modules and no `process`.
      compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
      mainModule: isolateSource.main,
      modules: { ...isolateSource.modules, "plugin.js": source },
      env: {},
      // No fetch() or connect() reaches anywhere, unless the plugin has `network`; then its requests go through
      // the guard, which refuses the server's own network as Node's does (network-guard.ts).
      globalOutbound: network ? this.guard() : null,
    }));
    const stub = this.ctx.facets.get(`plugin:${name}`, () => ({ class: worker.getDurableObjectClass("PluginIsolate") })) as unknown as IsolateStub;
    this.running.set(name, { stub, send: kept });
    await stub.start(source, network, kept);
  }

  /** The plugins' way out to the network: this Worker's NetworkGuard, with the hosts the deployment allows. */
  guard(): Fetcher {
    const allow = (this.env.ALLOW_PRIVATE_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    const exports = (this.ctx as unknown as { exports: { NetworkGuard(options: { props: { allow: string[]; resolver: string } }): Fetcher } }).exports;
    return exports.NetworkGuard({ props: { allow, resolver: resolverFrom(this.env.DNS_RESOLVER) } });
  }

  async post(name: string, message: unknown): Promise<void> {
    await this.running.get(name)?.stub.deliver(message);
  }

  stop(name: string): Promise<void> {
    return this.inTurn(name, () => this.stopping(name));
  }

  private async stopping(name: string): Promise<void> {
    const one = this.running.get(name);
    if (!one) return;
    this.running.delete(name);
    release(one.send);
    try {
      this.ctx.facets.delete(`plugin:${name}`);
    } catch {}
  }

  /** The kernel asks to be woken for its earliest scheduled job (std/schedule/module.ts). */
  async wake(at: number | undefined): Promise<void> {
    if (at === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(at, Date.now()));
  }

  /** The space's members' email addresses, from the accounts (std/email/module.ts mails only these). */
  addresses(): Promise<string[]> {
    return this.env.ACCOUNTS.getByName("accounts").addresses(this.space);
  }

  /** Sends a message a server plugin sent, which the email module checked and wrote to the outbox. */
  deliver(message: Message): Promise<Delivery> {
    return send(this.env, message);
  }

  /** The space's members, with the names on their accounts (sync.ts tells each device, to show who changed what). */
  members(): Promise<{ id: string; name: string }[]> {
    return this.env.ACCOUNTS.getByName("accounts").members(this.space);
  }

  /** The kernel says what a door answers may have changed: whoever watches the door is told (Space.fetch, WATCH). */
  async changed(door: string): Promise<void> {
    tellWatchers(this.ctx, door);
  }

  site(url: string): Promise<Response> {
    const { pathname, search } = new URL(url);
    return this.env.ASSETS.fetch(new Request(`https://assets${pathname}${search}`));
  }
}

type Delivery = { ok: true; id: string } | { ok: false; error: string } | null;

/** Sends a message through Cloudflare Email Service, from EMAIL_FROM. Null when the deployment hasn't set both up. */
async function send(env: Env, message: Message): Promise<Delivery> {
  if (!env.EMAIL || !env.EMAIL_FROM) return null;
  try {
    const sent = await env.EMAIL.send({ to: message.to, from: env.EMAIL_FROM, subject: message.subject, text: message.text, ...(message.html !== undefined ? { html: message.html } : {}) });
    return { ok: true, id: sent.messageId };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { ok: false, error: `${e.code ? `${e.code}: ` : ""}${e.message ?? String(error)}` };
  }
}

/**
 * Where the Worker watches one of a space's doors, on the space's object: a WebSocket that says "changed" each
 * time the kernel says the door may answer differently, or a key for the space ended. It is how an MCP
 * client's stream, kept open in the Worker, knows when to ask the door again without asking on a timer
 * (src/server/mcp.ts mcpStream). The object takes it with the hibernation API, so an open stream doesn't keep
 * the space's object in memory. No request from outside reaches this path: the front door sends the object
 * only /s/<space>/kernel.
 */
const WATCH = /^\/watch\/([a-z]+)$/;
const tellWatchers = (ctx: DurableObjectState, door: string) => {
  for (const socket of ctx.getWebSockets(`watch:${door}`)) {
    try {
      socket.send("changed");
    } catch {}
  }
};

/** The header the Worker names a space's client's member with, for the space to know them by. */
const MEMBER = "x-ewa-member";

export class Space extends DurableObject<Env> {
  /** The open clients, by the member each one is. */
  private clients = new Map<WebSocket, string>();
  private plugins?: PluginHost;
  private live = createLiveMcpRelay();

  /** Someone left the space, or was removed: their connections close at once. */
  async revoke(user: string): Promise<void> {
    for (const [socket, who] of this.clients) if (who === user) socket.close(4403, "You're no longer in this space");
  }

  /** The space's kernel, a facet running the kernel's class from its own isolate. */
  private kernel(space: string): KernelStub {
    this.plugins ??= new PluginHost(this.ctx, this.env, space);
    const guard = this.plugins.guard();
    const worker = this.env.LOADER.get(`space:${space}:${KERNEL_VERSION}`, async () => ({
      compatibilityDate: "2026-11-01",
      mainModule: kernelSource.main,
      modules: kernelSource.modules,
      // The kernel makes vendor calls for plugins with `network:<host>` (net.fetch), guarded like plugin isolates.
      globalOutbound: guard,
    }));
    return this.ctx.facets.get("kernel", () => ({ class: worker.getDurableObjectClass("SpaceKernel") })) as unknown as KernelStub;
  }

  /** A public route's request for this space (src/server/routes.ts), which its kernel answers, or null. */
  async route(space: string, origin: string, request: RouteRequest): Promise<RouteResponse | null> {
    this.plugins ??= new PluginHost(this.ctx, this.env, space);
    await this.remember(space, origin);
    return this.kernel(space).route(origin, request, this.plugins);
  }

  /** The space's folder, as a copy to move it to another host (src/server/transfer.ts). */
  async exportCopy(space: string): Promise<SpaceCopy> {
    return this.kernel(space).dump(space);
  }

  /** Loads a copy into the space, which must be empty, then starts its kernel on it, so its server plugins and jobs run. */
  async importCopy(space: string, origin: string, copy: SpaceCopy): Promise<{ files: number }> {
    if (this.clients.size) throw new Error("Someone has the space open: make a new space for the copy");
    const done = await this.kernel(space).load(copy);
    this.plugins ??= new PluginHost(this.ctx, this.env, space);
    await this.remember(space, origin);
    await this.kernel(space).tick(origin, this.plugins);
    return done;
  }

  /** Which space this is and where it's served, for an alarm, which comes with neither. */
  private async remember(space: string, origin: string): Promise<void> {
    const known = await this.ctx.storage.get<{ space: string; origin: string }>("where");
    if (known?.space !== space || known.origin !== origin) await this.ctx.storage.put("where", { space, origin });
  }

  /** A plugin's scheduled job came due (PluginHost.wake set the alarm): the kernel runs it, with no client. */
  async alarm(): Promise<void> {
    const where = await this.ctx.storage.get<{ space: string; origin: string }>("where");
    if (!where) return;
    this.plugins ??= new PluginHost(this.ctx, this.env, where.space);
    await this.kernel(where.space).tick(where.origin, this.plugins);
  }

  /** An agent key for the space ended: the Worker's open streams check theirs again. */
  async keysChanged(): Promise<void> {
    tellWatchers(this.ctx, "mcp");
  }

  /** A watcher went: its end is closed too. (Nothing is kept for one but the socket itself.) */
  webSocketClose(socket: WebSocket, code: number): void {
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {}
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const liveBridge = /^\/mcp\/live\/([0-9a-f]{32})\/bridge$/.exec(url.pathname);
    if (liveBridge) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      const bridge = this.live.attach(liveBridge[1], server);
      server.addEventListener("message", (e) => bridge.message(String(e.data)));
      server.addEventListener("close", () => bridge.close());
      server.addEventListener("error", () => bridge.close());
      return new Response(null, { status: 101, webSocket: client });
    }
    const liveHttp = /^\/mcp\/live\/([0-9a-f]{32})(?:\/([A-Za-z0-9_-]{24,64}))?\/?$/.exec(url.pathname);
    if (liveHttp) return this.live.handle(request, liveHttp[1], liveHttp[2]);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const watched = WATCH.exec(url.pathname)?.[1];
    if (watched) {
      const { 0: watcher, 1: here } = new WebSocketPair();
      this.ctx.acceptWebSocket(here, [`watch:${watched}`]);
      return new Response(null, { status: 101, webSocket: watcher });
    }
    const space = /^\/s\/([^/]+)\/kernel$/.exec(url.pathname)?.[1] ?? "";
    const kernel = this.kernel(space);
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.clients.set(server, request.headers.get(MEMBER) ?? "");
    const id = crypto.randomUUID();
    // The client's messages wait for the kernel to be ready for them, in order.
    this.plugins ??= new PluginHost(this.ctx, this.env, space);
    await this.remember(space, url.origin);
    let ready = kernel.join(id, url.origin, (text) => server.send(text), this.clients.get(server) ?? "", this.plugins);
    ready.catch((e) => console.error(`Space ${space}: the kernel didn't start`, e?.stack ?? e));
    server.addEventListener("message", (e) => {
      ready = ready.then(() => kernel.deliver(id, String(e.data))).catch(() => server.close(1011, "The kernel stopped"));
    });
    server.addEventListener("close", () => {
      this.clients.delete(server);
      void ready.then(() => kernel.leave(id)).catch(() => {});
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}

/** Every account, their passkeys and sessions: one object, so a passkey is only ever registered once. */
export class Accounts extends DurableObject<Env> {
  // Other sites to sign in with come from the Worker's vars (AUTH_PROVIDERS) and secrets (<ID>_CLIENT_SECRET).
  private auth = accounts(durableFiles(this.ctx.storage.sql as unknown as Sql), providersFrom(this.env as unknown as Record<string, unknown>, providerModules), {
    left: (space, user) => this.env.SPACE.getByName(space).revoke(user),
    keys: (space) => this.env.SPACE.getByName(space).keysChanged(),
    mail: (message) => send(this.env, message),
  });

  async fetch(request: Request): Promise<Response> {
    return (await this.auth.handle(request)) ?? new Response("Not found", { status: 404 });
  }

  /** Whether a space by this name exists. */
  async exists(space: string): Promise<boolean> {
    return this.auth.exists(space);
  }

  /** The email addresses a space's members gave: the only ones its server plugins may email. */
  async addresses(space: string): Promise<string[]> {
    return this.auth.addresses(space);
  }

  /** A space's members, with the names on their accounts. */
  async members(space: string): Promise<{ id: string; name: string }[]> {
    return this.auth.members(space);
  }

  /** The role in a space of the session in a cookie header, if they're in it. */
  async role(cookie: string, space: string): Promise<"owner" | "member" | null> {
    return (await this.auth.member(new Request("https://accounts/", { headers: { cookie } }), space))?.role ?? null;
  }

  /** Who the session in a cookie header is in a space, with the name on their account and their role, if they're in it. */
  async who(cookie: string, space: string): Promise<{ id: string; name: string; role: "owner" | "member" } | null> {
    const found = await this.auth.member(new Request("https://accounts/", { headers: { cookie } }), space);
    return found ? { id: found.user.id, name: found.user.name, role: found.role } : null;
  }

  /** What unlocks the model key a space holds, kept here and not in the space (src/server/space-model.ts). */
  async modelLock(space: string): Promise<string> {
    return this.auth.modelLock(space);
  }

  /** Which member of a space the session in a cookie header is, if it's one. */
  async member(cookie: string, space: string): Promise<string | null> {
    return (await this.auth.member(new Request("https://accounts/", { headers: { cookie } }), space))?.user.id ?? null;
  }

  /** Which member of a space an agent's key (an Authorization header) is for, if it's one (src/server/mcp.ts). */
  async agent(authorization: string | null, space: string, plugin?: string): Promise<{ user: string; key: string; expires?: number } | null> {
    return this.auth.agent(authorization, space, plugin);
  }
}

/** An MCP request from a member's agent (src/server/mcp.ts); undefined when the address isn't one. */
async function mcp(request: Request, env: Env): Promise<Response | undefined> {
  const url = new URL(request.url);
  // The front door has already found the space (src/server/front-door.ts).
  const at = mcpAddress(url);
  if (!at) return undefined;
  const accounts = env.ACCOUNTS.getByName("accounts");
  const asked = await mcpRequest(request, at, (authorization, space, plugin) => accounts.agent(authorization, space, plugin));
  if (asked instanceof Response) return asked;
  const space = env.SPACE.getByName(at.space);
  // A client's GET stream stays open in the Worker. The space's object isn't held open for it, or asked on a timer:
  // the Worker watches the door (WATCH), and asks only when the object says something may have changed.
  if (asked.method === "GET") {
    const authorization = request.headers.get("authorization");
    const watch: Watch = async (wake, lost) => {
      const opened = await space.fetch(new Request("https://space/watch/mcp", { headers: { upgrade: "websocket" } }));
      const socket = opened.webSocket;
      if (!socket) throw new Error("The space didn't let its door be watched");
      socket.accept();
      socket.addEventListener("message", () => wake());
      // The socket went (the space's object restarted, or the connection dropped): nothing would wake the stream again.
      socket.addEventListener("close", () => lost());
      socket.addEventListener("error", () => lost());
      return () => {
        try {
          socket.close(1000, "The stream ended");
        } catch {}
      };
    };
    return mcpStream(asked, (knock) => space.route(at.space, url.origin, knock), watch, { key: () => accounts.agent(authorization, at.space, at.plugin) });
  }
  return mcpResponse(await space.route(at.space, url.origin, asked));
}

/** A request to /s/<space>/<path> that one of the space's server plugins answers; undefined when none does. */
async function publicRoute(request: Request, env: Env, at: { space: string; path: string }): Promise<Response | undefined> {
  const route = await routeRequest(request, at.path);
  if (!route) return tooLarge();
  const url = new URL(request.url);
  const result = await env.SPACE.getByName(at.space).route(at.space, url.origin, route);
  return result ? routeResponse(result, url, at.space) : undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // The front door (src/server/front-door.ts) decides; this only reaches the Durable Objects and the assets.
    // The accounts are reached only when the door asks: a request it settles alone (a bad space name) needs none.
    const accounts = () => env.ACCOUNTS.getByName("accounts");
    const decision = await frontDoor(
      {
        method: request.method,
        url: new URL(request.url),
        origin: request.headers.get("origin"),
        cookie: request.headers.get("cookie") ?? "",
        upgrade: request.headers.get("upgrade")?.toLowerCase() === "websocket",
      },
      { exists: (space) => accounts().exists(space), member: (cookie, space) => accounts().member(cookie, space) },
    );
    return answer(request, env, decision);
  },
} satisfies ExportedHandler<Env>;

/** The private hosts the deployment lets through anyway (ALLOW_PRIVATE_HOSTS), for tests under wrangler dev. */
const allowedPrivate = (env: Env) => new Set((env.ALLOW_PRIVATE_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase().replace(/^\[|\]$/g, "")).filter(Boolean));

async function answer(request: Request, env: Env, decision: Decision): Promise<Response> {
  switch (decision.door) {
    case "auth": {
      // Moving a space (src/server/transfer.ts): its folder is the space's, which the accounts can't reach.
      const moved = await transferRoute(request, {
        role: (req, space) => env.ACCOUNTS.getByName("accounts").role(req.headers.get("cookie") ?? "", space),
        exportSpace: (space) => env.SPACE.getByName(space).exportCopy(space),
        importSpace: (space, copy, origin) => env.SPACE.getByName(space).importCopy(space, origin, copy),
      });
      if (moved) return moved;
      // A model key a space holds for its members (src/server/space-model.ts): used in the space's own kernel.
      const accounts = env.ACCOUNTS.getByName("accounts");
      const asked = await modelRoute(request, {
        member: (req, space) => accounts.who(req.headers.get("cookie") ?? "", space),
        lock: (space) => accounts.modelLock(space),
        ask: (space, origin, route) => env.SPACE.getByName(space).route(space, origin, route),
        gateways: gatewaysFrom(env.MODEL_GATEWAYS, [...allowedPrivate(env)]),
      });
      return asked ?? accounts.fetch(request);
    }
    case "join": {
      const forward = new Request(request);
      forward.headers.set(MEMBER, decision.member);
      return env.SPACE.getByName(decision.space).fetch(forward);
    }
    case "live-bridge":
    case "live-mcp":
      return env.SPACE.getByName(`_live:${decision.channel}`).fetch(request);
    case "route":
      return (await mcp(request, env)) ?? (await publicRoute(request, env, decision)) ?? answer(request, env, unrouted(request.method));
    case "feed":
      return feedReader(request, async (url, signal) => {
        // A host written as a private address is refused here, and so is a name that leads to one (names.ts), as on Node.
        if (!allowedPrivate(env).has(url.hostname.toLowerCase().replace(/^\[|\]$/g, ""))) {
          const inside = isOwnNetwork(url.hostname) || (await leadsInside(url.hostname, resolverFrom(env.DNS_RESOLVER)));
          if (inside) throw new Error(`The feed reader can't reach ${url.host}: it is on the server's own network`);
        }
        return fetch(url, { redirect: "manual", signal, headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" } });
      });
    case "asset":
      return env.ASSETS.fetch(request);
    case "refuse":
      return new Response(decision.text, { status: decision.status });
  }
}
