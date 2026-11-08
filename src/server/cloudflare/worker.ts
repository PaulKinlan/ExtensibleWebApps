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
// Until sign-in (step 5 of docs/server.md), anyone who can reach a space can
// write to it, so spaces are closed unless the SPACES variable is "open":
// `wrangler dev --var SPACES:open` on this machine, never in production.

import { DurableObject } from "cloudflare:workers";
// The space kernel's built source, as text (npm run build:cloudflare writes it).
import kernelSource from "../../../.build/cloudflare/kernel-source.js";

const SPACE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A new kernel build gets a new isolate; spaces on the old one move over as they restart. */
const KERNEL_VERSION = kernelSource.version;

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SPACE: DurableObjectNamespace<Space>;
  LOADER: WorkerLoader;
  /** "open" lets clients join spaces; anything else (the default) refuses them. */
  SPACES?: string;
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
    let ready = kernel.join(id, url.origin, (text) => server.send(text)); ready.then(() => console.log("joined"), (e) => console.log("join failed", e?.stack ?? e));
    server.addEventListener("message", (e) => {
      ready = ready.then(() => kernel.deliver(id, String(e.data))).catch(() => server.close(1011, "The kernel stopped"));
    });
    server.addEventListener("close", () => void ready.then(() => kernel.leave(id)).catch(() => {}));
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const space = /^\/s\/([^/]+)\/kernel$/.exec(new URL(request.url).pathname)?.[1];
    if (space === undefined) return env.ASSETS.fetch(request);
    if (env.SPACES !== "open") return new Response("Spaces open once sign-in is here", { status: 403 });
    if (!SPACE.test(space)) return new Response("Not a space", { status: 404 });
    return env.SPACE.getByName(space).fetch(request);
  },
} satisfies ExportedHandler<Env>;
