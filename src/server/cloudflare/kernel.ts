// A space's kernel on Cloudflare: the browser's kernel (src/kernel/kernel.ts)
// as a Durable Object class, which the space's supervisor (worker.ts) loads as
// a Dynamic Worker and runs as a facet. A Dynamic Worker loaded under the
// space's own id is an isolate of its own, so the kernel's module-level state
// is one space's alone, and a facet's SQLite database is the space's folder,
// which nothing else can read.
//
// The supervisor holds the clients' WebSockets. For each client it calls
// `join` with a way to send to it (not `connect`, which every stub already
// has, for sockets), then `deliver` for what the client says, and `leave` when
// it goes. Inside, each client is a MessagePort, as a tab is.

import { DurableObject } from "cloudflare:workers";
import { setEnv } from "../../kernel/env";
import { durableFiles, type Sql } from "../../seams/durable.ts";
import { signed } from "../signed.ts";

type Send = (text: string) => void | Promise<void>;

/**
 * Runs `load`, holding back the timers it sets until it is done, then setting them for real. A timer
 * cleared in the meantime never starts, and one cleared later is cleared by the id it was given.
 */
async function whileLoading<T>(load: () => Promise<T>): Promise<T> {
  const real = { setTimeout, setInterval, clearTimeout, clearInterval };
  const held = new Map<number, { repeat: boolean; fn: (...a: unknown[]) => void; ms?: number; args: unknown[] }>();
  const started = new Map<number, { handle: ReturnType<typeof setTimeout>; repeat: boolean }>();
  let next = 1;
  const hold = (repeat: boolean) => (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const id = -next++;
    held.set(id, { repeat, fn, ms, args });
    return id;
  };
  const clear = (id: unknown) => {
    if (typeof id === "number" && id < 0) {
      held.delete(id);
      const timer = started.get(id);
      started.delete(id);
      if (timer) (timer.repeat ? real.clearInterval : real.clearTimeout)(timer.handle);
      return;
    }
    real.clearTimeout(id as ReturnType<typeof setTimeout>);
  };
  Object.assign(globalThis, { setTimeout: hold(false), setInterval: hold(true), clearTimeout: clear, clearInterval: clear });
  try {
    return await load();
  } finally {
    Object.assign(globalThis, { setTimeout: real.setTimeout, setInterval: real.setInterval, clearTimeout: clear, clearInterval: clear });
    for (const [id, t] of held) started.set(id, { handle: (t.repeat ? real.setInterval : real.setTimeout)(t.fn, t.ms, ...t.args), repeat: t.repeat });
    held.clear();
  }
}

export class SpaceKernel extends DurableObject {
  private started?: Promise<(port: MessagePort) => void>;
  private clients = new Map<string, { port: MessagePort; send: Send; member: string }>();

  /** Starts the kernel the first time a client connects, with this space's folder. */
  private start(origin: string): Promise<(port: MessagePort) => void> {
    this.started ??= (async () => {
      let accept!: (port: MessagePort) => void;
      setEnv({
        kind: "server",
        origin,
        folder: durableFiles(this.ctx.storage.sql as unknown as Sql),
        connect: (a) => void (accept = a),
        onError: (report) => {
          addEventListener("error", (e) => report("kernel:error", String((e as ErrorEvent).message ?? e)));
          addEventListener("unhandledrejection", (e) => report("kernel:unhandled", String((e as PromiseRejectionEvent).reason)));
        },
      });
      // Cloudflare runs a module's top level outside any request, where timers aren't allowed, and the
      // kernel sets some as it starts (the trace's batches, say). Those wait until it has loaded.
      await whileLoading(() => import("../../kernel/kernel"));
      return accept;
    })();
    return this.started;
  }

  /** A client joins, as `member` of the space (which the supervisor's Worker checked). */
  async join(client: string, origin: string, send: Send, member = ""): Promise<void> {
    const accept = await this.start(origin);
    // A function passed over RPC lasts only as long as the call, unless it is kept with dup().
    const kept = (send as Send & { dup?: () => Send }).dup?.() ?? send;
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (e) => {
      try {
        void kept(JSON.stringify(e.data));
      } catch {
        // Something that isn't JSON (a canvas, a port) has no meaning to a remote client.
      }
    };
    this.clients.set(client, { port: port1, send: kept, member });
    accept(port2);
  }

  async deliver(client: string, text: string): Promise<void> {
    const found = this.clients.get(client);
    // The kernel learns who this client is from its hello, which only the supervisor may say.
    found?.port.postMessage(signed(JSON.parse(text), found.member));
  }

  async leave(client: string): Promise<void> {
    const gone = this.clients.get(client);
    this.clients.delete(client);
    gone?.port.postMessage({ t: "bye" });
    gone?.port.close();
    (gone?.send as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]?.();
  }
}

export default {
  fetch: () => new Response("A space's kernel answers its supervisor only", { status: 404 }),
};
