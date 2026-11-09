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
//
// Everywhere, it gives the `sync` service (service.ts): how a page stands
// with its space, its drafts, and the space's members.
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
import { serverApps } from "./server-apps";
import service from "./service";

export default {
  name: "spaces",
  apply(_ctx, kernel) {
    const where = env();
    const { root, store, hosts, remote, collections: records, reviews, userAdded, reopen } = kernel;
    kernel.provide("sync", service(kernel));

    if (hosts.mode === "server") {
      /** The apps opened in the space, whose server plugins it runs: only on a server that runs plugins. */
      const onServer = where.isolates ? serverApps(remote, store, where.origin, where.site) : undefined;
      const hub = syncHub(root, store, records, hosts, (app) => onServer?.use(app));
      // A space keeps the plugins its members share with each other, and never runs them.
      hub.plugins = spacePlugins(userAdded, store, hosts, (message) => hub.tell(message)).handle;
      // A space's server has no screen: its reviews are shown on members' devices.
      kernel.cleanup(relayReviews(reviews, hub, (host, message) => hosts.send(host, message)));
      kernel.message("sync", (host, message) => hub.handle(host, message));
      root.on("internal/left", (host: Parameters<typeof hub.hostLeft>[0]) => hub.hostLeft(host));
      kernel.space({ server: onServer });
      kernel.cleanup(() => {
        hub.plugins = undefined;
        hub.reviews = undefined;
      });
      return;
    }

    // In a browser: a page at /s/<space>/… keeps a copy of the space, once the kernel has its data folder.
    // Any other kernel refuses sync, as it always has: only a space's kernel orders changes.
    kernel.message("sync", (host) => hosts.send(host, { t: "sync", op: "refused", error: "Only a space's kernel answers sync" }));
    let device: ReturnType<typeof syncDevice> | undefined;
    let shared: ReturnType<typeof devicePlugins> | undefined;
    const begin = () => {
      if (!where.space || device) return;
      device = syncDevice(`${where.origin.replace(/^http/, "ws")}/s/${where.space}/kernel`, store, records, hosts);
      shared = devicePlugins(userAdded, store, hosts, device, reopen);
      deviceReviews(reviews, device);
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
      shared?.stop();
      device?.stop();
      device = shared = undefined;
    });
  },
} satisfies KernelModule;
