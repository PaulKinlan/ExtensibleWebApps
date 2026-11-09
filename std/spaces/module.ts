// The spaces module: what lets an app open in a space (/s/<space>/…) and be
// shared by its members. Without it in kernel.json, a site keeps no spaces.
//
// In a browser kernel for a space, once it has its data folder:
//   - device.ts syncs this device's copy with the space's kernel
//   - plugins.ts sends the person's shared plugins to the space, and puts
//     other members' here, turned off
//   - reviews.ts shows here the review cards the space's server asks
//
// In a space's kernel on a server:
//   - hub.ts orders every device's changes, refuses stale ones, and sends
//     each accepted change to every device (the `sync` messages)
//   - server-apps.ts starts the server plugins of the apps members open
//   - plugins.ts keeps the plugins members share, and never runs them
//   - reviews.ts sends its review cards to members' devices
//   - reflect.ts answers a member's debugger: what runs in this kernel
//   - trace.ts streams this kernel's trace to a member's debugger that asks
//   - live.ts passes live messages (a game's moves and frames) between
//     members' devices and the space's server plugins, without keeping them
//
// Everywhere, it gives the `sync` service (service.ts): how a page stands
// with its space, its drafts, the space's members, and (for a debugger)
// what runs in the space's own kernel.
//
// The core never names it: it lends the core what a space adds through
// kernel.space() and answers `sync` messages through kernel.message(). Like
// every module, all it adds goes when it stops (tests/checks/module-restart.mjs).

import { env } from "../../src/kernel/env";
import type { KernelModule } from "../../src/kernel/modules";
import { syncDevice } from "./device";
import { syncHub } from "./hub";
import { devicePlugins, spacePlugins } from "./plugins";
import { deviceReviews, relayReviews } from "./reviews";
import { spaceReflect } from "./reflect";
import { liveSpace, type LiveSpace } from "./live";
import { spaceTrace } from "./trace";
import { serverApps } from "./server-apps";
import service from "./service";

/**
 * Each space's hub that stopped, by the space's store, and the work it still had queued: a hub started
 * again for that space waits for it (a server can keep many spaces, so it isn't one per module).
 */
const draining = new WeakMap<object, Promise<unknown>>();

export default {
  name: "spaces",
  apply(_ctx, kernel) {
    const where = env();
    const { root, store, hosts, remote, collections: records, reviews, userAdded, reopen } = kernel;
    /** This space's live messages, on its server (live.ts): the sync service's live() sends through it. Each space has its own. */
    const space: { live?: LiveSpace } = {};
    kernel.provide("sync", service(kernel, space));

    if (hosts.mode === "server") {
      /** The apps opened in the space, whose server plugins it runs: only on a server that runs plugins. */
      const onServer = where.isolates ? serverApps(remote, store, where.origin, where.site) : undefined;
      const hub = syncHub(root, store, records, hosts, (app) => onServer?.use(app), draining.get(store));
      // A space keeps the plugins its members share with each other, and never runs them.
      const shared = spacePlugins(userAdded, store, hosts, (message) => hub.tell(message));
      hub.plugins = shared.handle;
      // A member's debugger may ask what runs here, from the kernel's own reflect service (reflect.ts).
      hub.reflect = spaceReflect(remote, hosts, shared);
      // A member's debugger may hear this kernel's trace as it happens (trace.ts).
      const streamed = spaceTrace(root, hosts);
      hub.trace = (host, message) => streamed.handle(host, message);
      // Live messages between members' devices and the server plugins (live.ts).
      const live = liveSpace(root, hosts);
      space.live = live;
      hub.live = (host, message) => live.heard(host, message);
      const leaving = (host: Parameters<typeof hub.hostLeft>[0]) => {
        streamed.left(host);
        live.left(host);
      };
      hub.left.add(leaving);
      // A space's server has no screen: its reviews are shown on members' devices.
      kernel.cleanup(relayReviews(reviews, hub, (host, message) => hosts.send(host, message)));
      kernel.message("sync", (host, message) => hub.handle(host, message));
      root.on("internal/left", (host: Parameters<typeof hub.hostLeft>[0]) => hub.hostLeft(host));
      kernel.space({ server: onServer });
      kernel.cleanup(() => {
        hub.plugins = undefined;
        hub.reviews = undefined;
        hub.reflect = undefined;
        hub.trace = undefined;
        hub.live = undefined;
        hub.left.delete(leaving);
        streamed.stop();
        live.stop();
        space.live = undefined;
        draining.set(store, hub.stop());
      });
      return;
    }

    // In a browser: a page at /s/<space>/… keeps a copy of the space, once the kernel has its data folder.
    // Any other kernel refuses sync, as it always has: only a space's kernel orders changes.
    kernel.message("sync", (host) => hosts.send(host, { t: "sync", op: "refused", error: "Only a space's kernel answers sync" }));
    let device: ReturnType<typeof syncDevice> | undefined;
    let shared: ReturnType<typeof devicePlugins> | undefined;
    let stopReviews: (() => void) | undefined;
    const begin = () => {
      if (!where.space || device) return;
      device = syncDevice(`${where.origin.replace(/^http/, "ws")}/s/${where.space}/kernel`, store, records, hosts);
      shared = devicePlugins(userAdded, store, hosts, device, reopen);
      stopReviews = deviceReviews(reviews, device);
    };
    if (kernel.started()) begin();
    else root.on("internal/started", begin);
    kernel.space({
      ready: async () => device?.ready,
      use: (app) => device?.use(app),
      get sharing() {
        return shared;
      },
    });
    kernel.command("sync", () => (device ? device.state() : { space: false }));
    kernel.cleanup(() => {
      stopReviews?.();
      shared?.stop();
      device?.stop();
      device = shared = stopReviews = undefined;
    });
  },
} satisfies KernelModule;
