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

import { DurableObject } from "cloudflare:workers";
// The space kernel's built source, as text (npm run build:cloudflare writes it).
import kernelSource from "../../../.build/cloudflare/kernel-source.js";
import { durableFiles, type Sql } from "../../seams/durable.ts";
import { accounts } from "../auth/accounts.ts";
import { providersFrom } from "../auth/providers.ts";

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
  join(client: string, origin: string, send: (text: string) => void): Promise<void>;
  deliver(client: string, text: string): Promise<void>;
  leave(client: string): Promise<void>;
}

export class Space extends DurableObject<Env> {
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const space = /^\/s\/([^/]+)\/kernel$/.exec(url.pathname)?.[1] ?? "";
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const kernel = this.kernel(space);
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const id = crypto.randomUUID();
    // The client's messages wait for the kernel to be ready for them, in order.
    let ready = kernel.join(id, url.origin, (text) => server.send(text));
    ready.catch((e) => console.error(`Space ${space}: the kernel didn't start`, e?.stack ?? e));
    server.addEventListener("message", (e) => {
      ready = ready.then(() => kernel.deliver(id, String(e.data))).catch(() => server.close(1011, "The kernel stopped"));
    });
    server.addEventListener("close", () => void ready.then(() => kernel.leave(id)).catch(() => {}));
    return new Response(null, { status: 101, webSocket: client });
  }
}

/** Every account, their passkeys and sessions: one object, so a passkey is only ever registered once. */
export class Accounts extends DurableObject<Env> {
  // Other sites to sign in with come from the Worker's vars (AUTH_PROVIDERS) and secrets (<ID>_CLIENT_SECRET).
  private auth = accounts(durableFiles(this.ctx.storage.sql as unknown as Sql), providersFrom(this.env as unknown as Record<string, unknown>));

  async fetch(request: Request): Promise<Response> {
    return (await this.auth.handle(request)) ?? new Response("Not found", { status: 404 });
  }

  /** Whether the session in a cookie header is one of a space's members. */
  async member(cookie: string, space: string): Promise<boolean> {
    return !!(await this.auth.member(new Request("https://accounts/", { headers: { cookie } }), space));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/auth/")) return env.ACCOUNTS.getByName("accounts").fetch(request);
    const space = /^\/s\/([^/]+)\/kernel$/.exec(new URL(request.url).pathname)?.[1];
    if (space === undefined) return env.ASSETS.fetch(request);
    if (!SPACE.test(space)) return new Response("Not a space", { status: 404 });
    // A page on another site may open a WebSocket here (they aren't bound by CORS), so a browser's
    // client must come from this site's own pages. A client that isn't a browser sends no Origin.
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== new URL(request.url).origin) return new Response("Not from this site", { status: 403 });
    if (!(await env.ACCOUNTS.getByName("accounts").member(request.headers.get("cookie") ?? "", space))) return new Response("Only the space's members may join it", { status: 403 });
    return env.SPACE.getByName(space).fetch(request);
  },
} satisfies ExportedHandler<Env>;
