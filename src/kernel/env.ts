// What the kernel needs from wherever it runs. The kernel (kernel.ts) is the
// same code everywhere; an entry sets the environment first and then imports
// it: browser.ts for a shared or dedicated worker, and a server entry for a
// space kernel. Everything that differs between hosts is in here or in the
// seams (src/seams/), so kernel.ts never reaches for `self` or `navigator`.

import type { Email, Files, Isolates } from "../seams/index.ts";
import type { RouteRequest, RouteResponse } from "./routes";

export interface KernelEnv {
  /**
   * Where the kernel runs: a shared worker every tab talks to, a dedicated worker for one tab, or a
   * space kernel on a server. Only the shared kernel's routes are the site's.
   */
  kind: "shared" | "dedicated" | "server";
  /** The site the kernel serves, to tell its own plugins from others. */
  origin: string;
  /** Hands the kernel each new connection's port. Called once, before anything else, so none is missed. */
  connect(accept: (port: MessagePort) => void): void;
  /** Tells the kernel about its own uncaught errors and rejections, for the trace. */
  onError(report: (name: string, detail: string) => void): void;
  /** The kernel's folder, when the host has one. Without it, the first tab to connect passes its folder handle. */
  folder?: Files;
  /** In a browser, the space this kernel keeps a copy of and syncs with (std/spaces/device.ts), if it isn't the person's own. */
  space?: string;
  /** On a server, where the space's plugins run (src/seams/index.ts): without it, no plugin runs there. */
  isolates?: Isolates;
  /** On a server, how it reads the site's own files (an app's app.html and plugins), when not with fetch. */
  site?: (url: string) => Promise<Response>;
  /** On a server, how net.fetch reaches outside addresses without reaching the server's own network. */
  fetch?: typeof globalThis.fetch;
  /** On a server, private hosts net.fetch may reach anyway (for local development and server checks). */
  allowPrivate?: string[];
  /**
   * On a server, the email addresses the space's members gave on their accounts: the only ones its server
   * plugins may email (std/email/module.ts). Without it, no plugin sends email.
   */
  addresses?(): Promise<string[]>;
  /**
   * On a server, the space's members with the names they gave on their accounts, so a page can show who
   * made a change (`by` is a member's id) by name (std/spaces/hub.ts sends them to each device).
   */
  members?(): Promise<{ id: string; name: string }[]>;
  /**
   * On a server whose deployment can send email (Cloudflare Email Service on Cloudflare, SMTP on Node), sends
   * one message the email module has checked and written to the outbox. Without it, or when it answers null
   * (the deployment hasn't set mail up), mail stays in the outbox.
   */
  deliver?(message: Parameters<Email["send"]>[0]): Promise<Awaited<ReturnType<Email["send"]>> | null>;
  /**
   * On a host that can put a space to sleep (Cloudflare), asks to be woken at `at` (ms since 1970), or
   * not at all when undefined, for the earliest job plugins scheduled (std/schedule/module.ts).
   */
  wake?(at: number | undefined): void;
  /**
   * On a server, hands the kernel a way to start its plugins and scheduled jobs with no client
   * connected: when the host starts a space for a job (after a restart, or a Cloudflare alarm).
   */
  boot?(start: () => void): void;
  /**
   * On a server, hands the kernel's answer for the space's public routes (a server plugin's
   * ctx.routes.add), which the host calls for an HTTP request to /s/<space>/<path> (src/server/routes.ts).
   * The answer is null when no plugin has that route.
   */
  serve?(answer: (request: RouteRequest) => Promise<RouteResponse | null>): void;
  /**
   * On a server, tells the host that what a door answers may have changed (the door `mcp`: its tools, or
   * which stream a session has), so the host asks the door again for the connections it keeps open, and
   * doesn't have to ask on a timer (src/server/mcp.ts mcpStream).
   */
  changed?(door: string): void;
}

let current: KernelEnv | undefined;

/** Called by an entry, once, before it imports the kernel. */
export function setEnv(env: KernelEnv): void {
  if (current) throw new Error("The kernel's environment is set once");
  current = env;
}

/** The environment the entry set. */
export function env(): KernelEnv {
  if (!current) throw new Error("Import the kernel through an entry (browser.ts, or a server entry), which sets its environment first");
  return current;
}
