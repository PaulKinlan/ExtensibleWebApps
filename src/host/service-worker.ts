// Registers the platform's service worker (/sw.js) and answers it. The service
// worker can't reach the shared-worker kernel itself, so when it needs the
// kernel (a request to a plugin's route) it asks an open tab, and the tab's
// host passes the question on as a command.
//
// The page never waits for the service worker: the first visit to a site
// isn't controlled by it, and everything works without it.

import type { Command } from "../shared/protocol";

/** What the service worker may ask the kernel. Everything else is refused. */
const ALLOWED = new Set<Command>(["route"]);

export function serviceWorker(command: (name: Command, arg?: unknown) => Promise<unknown>, report: (source: string, text: string) => void): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const reply = e.ports[0];
    if (!reply || e.data?.t !== "sw:kernel") return;
    if (!ALLOWED.has(e.data.name)) return reply.postMessage({ ok: false, error: `The service worker can't ask for ${e.data.name}` });
    command(e.data.name, e.data.arg).then(
      (value) => reply.postMessage({ ok: true, value }),
      (error) => reply.postMessage({ ok: false, error: String(error instanceof Error ? error.message : error) }),
    );
  });
  navigator.serviceWorker.register("/sw.js", { type: "module", scope: "/" }).catch((error) => report("service-worker", `Couldn't start the service worker: ${error instanceof Error ? error.message : error}`));
}
