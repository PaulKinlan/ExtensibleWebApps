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

/**
 * `introduced` settles once the kernel knows this tab (it answers no command before then). `outOfDate` is called
 * when the service worker finds this page is from before the site's last deploy and a part it asked for is gone.
 */
export function serviceWorker(command: (name: Command, arg?: unknown) => Promise<unknown>, report: (source: string, text: string) => void, introduced: Promise<void>, outOfDate: () => void): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const reply = e.ports[0];
    if (reply && e.data?.t === "sw:out-of-date") {
      // Heard: the worker leaves this tab to its host (it reloads only a tab with nothing to hear it).
      reply.postMessage(true);
      return outOfDate();
    }
    if (!reply || e.data?.t !== "sw:kernel") return;
    if (!ALLOWED.has(e.data.name)) return reply.postMessage({ ok: false, error: `The service worker can't ask for ${e.data.name}` });
    // Taken: the service worker waits for this tab's answer instead of asking another tab.
    reply.postMessage({ taken: true });
    command(e.data.name, e.data.arg).then(
      (value) => reply.postMessage({ ok: true, value }),
      (error) => reply.postMessage({ ok: false, error: String(error instanceof Error ? error.message : error) }),
    );
  });
  const first = !navigator.serviceWorker.controller;
  navigator.serviceWorker.register("/sw.js", { type: "module", scope: "/" }).catch((error) => report("service-worker", `Couldn't start the service worker: ${error instanceof Error ? error.message : error}`));
  // On the first visit the page loaded before the service worker started, so it kept nothing: tell it what this page loaded.
  if (first) {
    /** Addresses already sent, so each is fetched again and kept once. */
    const sent = new Set<string>();
    const warm = (registration: ServiceWorkerRegistration, list: unknown[]) => {
      const urls = list.filter((u): u is string => typeof u === "string" && new URL(u, location.href).origin === location.origin && !sent.has(u));
      for (const url of urls) sent.add(url);
      if (urls.length) registration.active?.postMessage({ t: "sw:warm", urls });
    };
    void navigator.serviceWorker.ready.then(async (registration) => {
      const loaded = () => [location.href, ...performance.getEntriesByType("resource").map((entry) => entry.name)];
      warm(registration, loaded());
      // And what the kernel fetched in its own worker, which this page's list doesn't have: the kernel modules its
      // app uses. The kernel answers once this tab has said hello. Both lists are read again a little later, for a
      // file that was still on its way (asked for before the service worker was there to keep it, and not
      // finished when the list was first read): an element a view needed, or a module's file.
      await introduced;
      for (const wait of [0, 3000, 15000]) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        warm(registration, [...loaded(), ...(((await command("fetched").catch(() => [])) as unknown[] | undefined) ?? [])]);
      }
    });
  }
}
