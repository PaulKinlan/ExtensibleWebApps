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
import { accounts } from "../auth/accounts.ts";
import { providersFrom } from "../auth/providers.ts";
import { type RouteRequest, type RouteResponse, routeRequest, routeResponse, spaceRoute, tooLarge } from "../routes.ts";

const SPACE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A new kernel build gets a new isolate; spaces on the old one move over as they restart. */
const KERNEL_VERSION = kernelSource.version;

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SPACE: DurableObjectNamespace<Space>;
  ACCOUNTS: DurableObjectNamespace<Accounts>;
  LOADER: WorkerLoader;
}

interface KernelStub {
  join(client: string, origin: string, send: (text: string) => void, member?: string, host?: PluginHost): Promise<void>;
  deliver(client: string, text: string): Promise<void>;
  leave(client: string): Promise<void>;
  route(origin: string, request: RouteRequest, host?: PluginHost): Promise<RouteResponse | null>;
  tick(origin: string, host?: PluginHost): Promise<void>;
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
      // No fetch() or connect() reaches anywhere, unless the plugin has `network`.
      ...(network ? {} : { globalOutbound: null }),
    }));
    const stub = this.ctx.facets.get(`plugin:${name}`, () => ({ class: worker.getDurableObjectClass("PluginIsolate") })) as unknown as IsolateStub;
    this.running.set(name, { stub, send: kept });
    await stub.start(source, network, kept);
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

  site(url: string): Promise<Response> {
    const { pathname, search } = new URL(url);
    return this.env.ASSETS.fetch(new Request(`https://assets${pathname}${search}`));
  }
}

/** The header the Worker names a space's client's member with, for the space to know them by. */
const MEMBER = "x-ewa-member";

export class Space extends DurableObject<Env> {
  /** The open clients, by the member each one is. */
  private clients = new Map<WebSocket, string>();
  private plugins?: PluginHost;

  /** Someone left the space, or was removed: their connections close at once. */
  async revoke(user: string): Promise<void> {
    for (const [socket, who] of this.clients) if (who === user) socket.close(4403, "You're no longer in this space");
  }

  /** The space's kernel, a facet running the kernel's class from its own isolate. */
  private kernel(space: string): KernelStub {
    const worker = this.env.LOADER.get(`space:${space}:${KERNEL_VERSION}`, async () => ({
      compatibilityDate: "2026-11-01",
      mainModule: kernelSource.main,
      modules: kernelSource.modules,
      // The kernel makes vendor calls for plugins with `network` (net.fetch), so it keeps the network.
    }));
    return this.ctx.facets.get("kernel", () => ({ class: worker.getDurableObjectClass("SpaceKernel") })) as unknown as KernelStub;
  }

  /** A public route's request for this space (src/server/routes.ts), which its kernel answers, or null. */
  async route(space: string, origin: string, request: RouteRequest): Promise<RouteResponse | null> {
    this.plugins ??= new PluginHost(this.ctx, this.env, space);
    await this.remember(space, origin);
    return this.kernel(space).route(origin, request, this.plugins);
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const space = /^\/s\/([^/]+)\/kernel$/.exec(url.pathname)?.[1] ?? "";
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
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
  private auth = accounts(durableFiles(this.ctx.storage.sql as unknown as Sql), providersFrom(this.env as unknown as Record<string, unknown>), {
    left: (space, user) => this.env.SPACE.getByName(space).revoke(user),
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

  /** Which member of a space the session in a cookie header is, if it's one. */
  async member(cookie: string, space: string): Promise<string | null> {
    return (await this.auth.member(new Request("https://accounts/", { headers: { cookie } }), space))?.user.id ?? null;
  }
}

/** A request to /s/<space>/<path> that one of the space's server plugins answers; undefined when none does. */
async function publicRoute(request: Request, env: Env): Promise<Response | undefined> {
  const url = new URL(request.url);
  const at = spaceRoute(url);
  if (!at || !SPACE.test(at.space) || !(await env.ACCOUNTS.getByName("accounts").exists(at.space))) return undefined;
  const route = await routeRequest(request, at.path);
  if (!route) return tooLarge();
  const result = await env.SPACE.getByName(at.space).route(at.space, url.origin, route);
  if (result) return routeResponse(result, url, at.space);
  // Its body is read, so the site's files can't have it: they answer only GET and HEAD anyway.
  return request.method === "GET" || request.method === "HEAD" ? undefined : new Response("Method not allowed", { status: 405 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/auth/")) return env.ACCOUNTS.getByName("accounts").fetch(request);
    const space = /^\/s\/([^/]+)\/kernel$/.exec(new URL(request.url).pathname)?.[1];
    if (space === undefined) return (await publicRoute(request, env)) ?? env.ASSETS.fetch(request);
    if (!SPACE.test(space)) return new Response("Not a space", { status: 404 });
    // A page on another site may open a WebSocket here (they aren't bound by CORS), so a browser's
    // client must come from this site's own pages. A client that isn't a browser sends no Origin.
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== new URL(request.url).origin) return new Response("Not from this site", { status: 403 });
    const member = await env.ACCOUNTS.getByName("accounts").member(request.headers.get("cookie") ?? "", space);
    if (!member) return new Response("Only the space's members may join it", { status: 403 });
    const forward = new Request(request);
    forward.headers.set(MEMBER, member);
    return env.SPACE.getByName(space).fetch(forward);
  },
} satisfies ExportedHandler<Env>;
