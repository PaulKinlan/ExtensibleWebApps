// The `debug` service. The trace, for developer tools.
// Found by name: this file is src/kernel/services/debug.ts, so it is `ctx.call("debug", …)`.

import { recent, startedAt } from "../trace";
import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";

export default ({ apps }: Kernel): ServiceProvider => {
  return {
    description: "The trace: everything the kernel, the pages and plugins did, and every error. For developer tools such as std/debug-console.js; hear new events with the `debug:trace` hook.",
    methods: {
      recent: {
        args: "()",
        returns: "{ startedAt, events: [{ seq, at, kind, name, plugin?, trace?, ms?, detail? }], tab?, app? }",
        needs: "debug:read",
        description: "The last 500 trace events, oldest first; `seq` counts up with each event, and `at` is milliseconds after `startedAt` (wall-clock ms). A tab-scoped caller also gets its `tab`, and `app`: the ids of the plugins the app open in that tab links, once it has opened one.",
      },
      app: {
        args: "()",
        returns: "{ tab?, app? }",
        needs: "debug:read",
        description: "For a tab-scoped caller: its `tab`, and the ids of the plugins the app open there links, or no `app` if the tab hasn't opened one yet. The trace's `app:open` event says when to ask again.",
      },
    },
    capability: () => "debug:read",
    call: (plugin, method) => {
      const tab = plugin.split("@")[1];
      const where = tab ? { tab, app: apps.linkedBy(tab) } : {};
      if (method === "app") return where;
      if (method === "recent") return { startedAt, events: recent(), ...where };
      throw new Error(`debug.${method} is not a method`);
    },
  };
};
