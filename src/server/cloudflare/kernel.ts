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
//
// The supervisor also hands over `host`, where the space's server plugins run
// (each a Dynamic Worker of its own, isolate.ts) and how the site's own files
// are read.

import { DurableObject } from "cloudflare:workers";
import { setEnv, type PushAsk, type Pushed } from "../../kernel/env";
import type { Files, Message } from "../../seams/index.ts";
import { durableFiles, type Sql } from "../../seams/durable.ts";
import { type IsolateHost, remoteIsolates } from "../../seams/remote-isolates.ts";
import type { RouteRequest, RouteResponse } from "../routes.ts";
import { exportSpace, importSpace, type SpaceCopy } from "../space-copy.ts";
import { answerFor, signed } from "../signed.ts";
import { roleOf, type Role } from "../auth/roles.ts";

type Send = (text: string) => void | Promise<void>;
type Kept<T> = T & { dup?: () => T };

/** What the supervisor gives the kernel: where plugins run, and the site's files. */
export interface SpaceHost extends IsolateHost {
  site(url: string): Promise<Response>;
  /** The space's members' email addresses (the email service mails only these). */
  addresses(): Promise<string[]>;
  /** The space's members, with the names on their accounts. */
  members(): Promise<{ id: string; name: string; role?: Role }[]>;
  /** Sends a message through Cloudflare Email Service; null when the deployment hasn't set it up. */
  deliver(message: Message): Promise<{ ok: true; id: string } | { ok: false; error: string } | null>;
  /** Sends a notification to the members' devices (src/server/auth/push.ts), as the space served at `origin`. */
  push(note: PushAsk, origin: string): Promise<Pushed>;
  /** Sets the space's alarm for the earliest scheduled job, or clears it. */
  wake(at: number | undefined): Promise<void>;
  /** What a door answers may have changed (the door `mcp`): the Worker's open streams for the space ask it again. */
  changed(door: string): Promise<void>;
  /** Deployment-managed secrets (when the supervisor exposes them). */
  deploymentSecrets?(name: string): Promise<{ value: string; hosts: string[] } | undefined> | { value: string; hosts: string[] } | undefined;
}

const SECRET_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const SECRET_HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/;

function parseHosts(raw: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) list = parsed;
      } catch {}
    } else list = trimmed.split(",");
  }
  return list.filter((h): h is string => typeof h === "string").map((h) => h.trim().toLowerCase()).filter((h) => SECRET_HOST.test(h));
}

function deploymentSecretFromEnv(vars: Record<string, unknown>, name: string): { value: string; hosts: string[]; dailyCap?: number } | undefined {
  if (!SECRET_NAME.test(name)) return undefined;
  const defaultCap = typeof vars.DEPLOYMENT_SECRET_DAILY_CAP === "string" && /^\d+$/.test(vars.DEPLOYMENT_SECRET_DAILY_CAP) ? Number(vars.DEPLOYMENT_SECRET_DAILY_CAP) : undefined;
  let map: unknown = vars.DEPLOYMENT_SECRETS;
  if (typeof map === "string") {
    try {
      map = JSON.parse(map);
    } catch {
      map = undefined;
    }
  }
  if (map && typeof map === "object" && !Array.isArray(map) && Object.hasOwn(map, name)) {
    const entry = (map as Record<string, unknown>)[name] as { value?: unknown; hosts?: unknown; dailyCap?: unknown } | undefined;
    if (entry && typeof entry === "object" && typeof entry.value === "string" && entry.value) {
      const hosts = parseHosts(entry.hosts);
      if (hosts.length) {
        const cap = typeof entry.dailyCap === "number" && Number.isFinite(entry.dailyCap) && entry.dailyCap >= 0 ? Math.floor(entry.dailyCap) : defaultCap;
        return { value: entry.value, hosts, ...(cap !== undefined && { dailyCap: cap }) };
      }
    }
  }
  const key = name.toUpperCase().replace(/-/g, "_");
  const value = vars[`EWA_SECRET_${key}`] ?? vars[`EWA_SECRET_${name}`];
  const rawHosts = vars[`EWA_SECRET_${key}_HOSTS`] ?? vars[`EWA_SECRET_${name}_HOSTS`];
  if (typeof value !== "string" || !value) return undefined;
  const hosts = parseHosts(rawHosts);
  if (!hosts.length) return undefined;
  const rawCap = vars[`EWA_SECRET_${key}_DAILY_CAP`] ?? vars[`EWA_SECRET_${name}_DAILY_CAP`];
  const cap = typeof rawCap === "string" && /^\d+$/.test(rawCap) ? Number(rawCap) : defaultCap;
  return { value, hosts, ...(cap !== undefined && { dailyCap: cap }) };
}

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

/** Starts the kernel's plugins and jobs with no client (for an alarm), once it has loaded. */
let boot: (() => void) | undefined;
/** The kernel's answer for a public route, once it has started. */
let answerRoute: ((request: RouteRequest) => Promise<RouteResponse | null>) | undefined;

export class SpaceKernel extends DurableObject {
  private started?: Promise<(port: MessagePort) => void>;
  private clients = new Map<string, { port: MessagePort; send: Send; member: string; role?: Role }>();

  /** Starts the kernel the first time a client connects, with this space's folder. */
  private start(origin: string, given?: SpaceHost): Promise<(port: MessagePort) => void> {
    this.started ??= (async () => {
      let accept!: (port: MessagePort) => void;
      // Kept for as long as the kernel runs, not just this call.
      const host = given && ((given as Kept<SpaceHost>).dup?.() ?? given);
      setEnv({
        kind: "server",
        origin,
        folder: durableFiles(this.ctx.storage.sql as unknown as Sql),
        connect: (a) => void (accept = a),
        serve: (answer) => void (answerRoute = answer),
        boot: (start) => void (boot = start),
        deploymentSecrets: (name: string) =>
          host?.deploymentSecrets ? host.deploymentSecrets(name) : deploymentSecretFromEnv(((this as unknown as { env?: Record<string, unknown> }).env ?? {}), name),
        ...(host && { wake: (at: number | undefined) => void host.wake(at).catch((error) => console.error("Couldn't set the space's alarm:", error)) }),
        ...(host && {
          isolates: remoteIsolates(host, (name, error) => console.error(`Plugin ${name}:`, error)),
          site: (url: string) => host.site(url),
          addresses: () => host.addresses(),
          members: () => host.members(),
          deliver: (message: Message) => host.deliver(message),
          push: (note: PushAsk) => host.push(note, origin),
          changed: (door: string) => void host.changed(door).catch(() => {}),
        }),
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
  async join(client: string, origin: string, send: Send, member = "", host?: SpaceHost, role?: string): Promise<void> {
    const accept = await this.start(origin, host);
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
    // What the member may do, as the Worker said; anything it didn't say is read as a reader, who changes nothing.
    this.clients.set(client, { port: port1, send: kept, member, role: role === undefined ? undefined : (roleOf(role) ?? "reader") });
    accept(port2);
  }

  /** A public route's request (src/server/routes.ts), which may be what wakes the space. Null if no plugin has it. */
  async route(origin: string, request: RouteRequest, host?: SpaceHost): Promise<RouteResponse | null> {
    await this.start(origin, host);
    return (await answerRoute?.(request)) ?? null;
  }

  /** The space's alarm went off: start the kernel (and so its jobs, which run whatever came due). */
  async tick(origin: string, host?: SpaceHost): Promise<void> {
    await this.start(origin, host);
    boot?.();
  }

  /** The space's folder, as a copy to move it to another host (src/server/transfer.ts). */
  async dump(space: string): Promise<SpaceCopy> {
    // One statement, so the copy is the folder at one moment even while the kernel runs.
    const files = new Map<string, Uint8Array>();
    const sql = this.ctx.storage.sql as unknown as Sql;
    durableFiles(sql);
    for (const row of sql.exec("SELECT path, data FROM files ORDER BY path").toArray()) files.set(String(row.path), new Uint8Array(row.data as ArrayBuffer));
    const snapshot: Pick<Files, "list" | "read"> = { list: async () => [...files.keys()], read: async (path) => files.get(path) ?? null };
    return exportSpace(snapshot as Files, space);
  }

  /** Loads a copy into the space's folder, which must be empty, before the kernel has started on it. */
  async load(copy: SpaceCopy): Promise<{ files: number }> {
    if (this.started) throw new Error("The space is already running: make a new space for the copy");
    return importSpace(durableFiles(this.ctx.storage.sql as unknown as Sql), copy);
  }

  async deliver(client: string, text: string): Promise<void> {
    const found = this.clients.get(client);
    // The kernel learns who this client is from its hello, which only the supervisor may say.
    if (!found) return;
    const message = JSON.parse(text);
    // A command the member may not run is answered here, with why; what isn't let through never reaches the kernel.
    const answer = answerFor(message, found.role);
    if (answer) void found.send(JSON.stringify(answer));
    const heard = signed(message, found.member, found.role);
    if (heard !== null) found.port.postMessage(heard);
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
