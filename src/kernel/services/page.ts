// The `page` service. The app's own page, as far as a plugin's places reach into it.
// Found by name: this file is src/kernel/services/page.ts, so it is `ctx.call("page", …)`.

import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";

const base = (instance: string) => instance.split("@")[0];

export default ({ hosts, remote, apps }: Kernel): ServiceProvider => {
  return {
    description: "The app's own page, as far as a plugin's places reach into it.",
    methods: {
      matches: {
        args: "(place)",
        returns: "[{ text, data }]",
        needs: "ui",
        description:
          "What one of the plugin's places matches in the page: each element's text (up to 500 characters) and its data-* attributes, in page order. A plugin with `each: true` draws a view per match by rendering to `<place>#<index>`.",
      },
    },
    capability: () => "ui",
    call: (plugin, method, args, dispatch) => {
      if (method !== "matches") throw new Error(`page.${method} is not a method`);
      const id = base(plugin);
      if (typeof args[0] !== "string" || !remote.installed.get(id)?.manifest.places?.[args[0]]) throw new Error(`${id} has no place named ${String(args[0])}`);
      // A tab-scoped plugin asks its own tab; a shared one, any tab with its app open.
      const tab = plugin.split("@")[1];
      const host = hosts.list.find((h) => (tab ? h.tab === tab : apps.linkedBy(h.tab)?.includes(id)));
      if (!host) throw new Error("No tab has this plugin's app open");
      return hosts.bridge("page", "matches", [id, args[0]], dispatch, host);
    },
  };
};
