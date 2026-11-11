// The spaces module: what lets an app open in a space (/s/<space>/…) and be
// shared by its members. Without it in kernel.json, a site keeps no spaces.
//
// In a browser kernel for a space, once it has its data folder, it loads
// on-device.ts (a kernel that keeps no space never does), which starts:
//   - device.ts syncs this device's copy with the space's kernel
//   - device-plugins.ts sends the person's shared plugins to the space, and
//     puts other members' here, turned off
//   - reviews.ts shows here the review cards the space's server asks
//   - device-made-apps.ts asks the space for the apps members made and shared,
//     for Your apps (std/maker), where each runs once the person accepts it
//
// In a space's kernel on a server:
//   - hub.ts orders every device's changes, refuses stale ones, and sends
//     each accepted change to every device (the `sync` messages)
//   - server-apps.ts starts the server plugins of the apps members open
//   - plugins.ts keeps the plugins members share, and never runs them
//   - made-apps.ts keeps the apps members made and share, and never runs them
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
import { record as trace } from "../../src/kernel/trace";
import type { KernelModule } from "../../src/kernel/modules";
import type { RouteRequest, RouteResponse } from "../../src/kernel/routes";
import { syncHub } from "./hub";
import { spaceMadeApps } from "./made-apps";
import type { startDevice } from "./on-device";
import { spacePlugins } from "./plugins";
import { relayReviews } from "./reviews";
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
      const onServer = where.isolates ? serverApps(remote, store, where.origin, where.site, () => root.emit("internal/learned")) : undefined;
      const hub = syncHub(root, store, records, hosts, (app) => onServer?.use(app), draining.get(store));
      // A space keeps the plugins its members share with each other, and never runs them.
      const shared = spacePlugins(userAdded, store, hosts, (message) => hub.tell(message));
      hub.plugins = shared.handle;
      // And the apps they made and shared (made-apps.ts), which it never runs either.
      hub.apps = spaceMadeApps(store, hosts, (message) => hub.tell(message)).handle;
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
      // A model key the space holds for its members (model-key.ts): the host knocks at this door for a member
      // it has checked, and the key is unlocked and used here only. Fetched the first time anyone asks.
      let model: Promise<(request: RouteRequest) => Promise<RouteResponse>> | undefined;
      const askModel = async (request: RouteRequest) => (await (model ??= import("./model-key").then((m) => m.spaceModel(store, where.fetch ?? fetch))))(request);
      // (Lent too, for a module the host let in with what unlocks the key: an agent an editor talks to, std/acp.)
      kernel.space({ server: onServer, model: askModel });
      kernel.door("model", askModel);
      kernel.cleanup(() => {
        hub.plugins = undefined;
        hub.apps = undefined;
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
    // The device's side (on-device.ts) is loaded only here, in a kernel for a space.
    let on: ReturnType<typeof startDevice> | undefined;
    let loading: Promise<void> | undefined;
    let stopped = false;
    const using = new Set<string>();
    const begin = () => {
      if (!where.space || loading) return;
      // Tried again until it loads (it is a file of this site, cached once fetched): the space opens only once it has.
      const attempt = (tries: number): Promise<void> =>
        import("./on-device").then(
          ({ startDevice }) => {
            if (stopped) return;
            on = startDevice(`${where.origin.replace(/^http/, "ws")}/s/${where.space}/kernel`, store, records, hosts, userAdded, reviews, reopen);
            for (const app of using) on.device.use(app);
          },
          (error) => {
            trace({ kind: "error", name: "sync:load", detail: error instanceof Error ? error.message : String(error) });
            return stopped ? undefined : new Promise<void>((r) => setTimeout(r, Math.min(1000 * 2 ** tries, 30_000))).then(() => (stopped ? undefined : attempt(tries + 1)));
          },
        );
      loading = attempt(0);
    };
    if (kernel.started()) begin();
    else root.on("internal/started", begin);
    kernel.space({
      ready: async () => {
        await loading;
        await on?.device.ready;
      },
      use: (app) => {
        using.add(app);
        on?.device.use(app);
      },
      get sharing() {
        return on?.shared;
      },
      get madeApps() {
        return on?.made;
      },
    });
    kernel.command("sync", async () => {
      await loading;
      return on ? on.device.state() : { space: false };
    });
    kernel.cleanup(() => {
      stopped = true;
      on?.stop();
      on = undefined;
    });
  },
} satisfies KernelModule;
