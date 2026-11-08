// What the kernel needs from wherever it runs. The kernel (kernel.ts) is the
// same code everywhere; an entry sets the environment first and then imports
// it: browser.ts for a shared or dedicated worker, and a server entry for a
// space kernel. Everything that differs between hosts is in here or in the
// seams (src/seams/), so kernel.ts never reaches for `self` or `navigator`.

import type { Files, Isolates } from "../seams/index.ts";

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
  /** In a browser, the space this kernel keeps a copy of and syncs with (sync-device.ts), if it isn't the person's own. */
  space?: string;
  /** On a server, where the space's plugins run (src/seams/index.ts): without it, no plugin runs there. */
  isolates?: Isolates;
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
