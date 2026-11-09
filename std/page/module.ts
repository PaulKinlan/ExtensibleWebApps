// The `page` service. The app's own page, as far as a plugin's places reach into it.
// A kernel module (docs/layers.md): a site that lists `page` in kernel.json has it, as `ctx.call("page", …)`.

import { service, type ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";

const base = (instance: string) => instance.split("@")[0];

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { hosts, remote, apps } = kernel;
  return {
    description: "The app's own page, as far as a plugin's places reach into it, and the slots plugins declare in their views.",
    methods: {
      matches: {
        args: "(place)",
        returns: "[{ text, data }]",
        needs: "ui",
        description:
          "What one of the plugin's places matches in the page: each element's text (up to 500 characters) and its data-* attributes, in page order. A plugin with `each: true` draws a view per match by rendering to `<place>#<index>`. When a transform's matches change (the plugin it changes drew again), the plugin hears the event \"place:changed\" with { place }.",
      },
      slots: {
        args: "(name)",
        returns: "[{ data }]",
        needs: "ui",
        description:
          "The slots of a name that plugins declared in their views (`<slot name=\"cookbook.recipe.actions\" data-id=\"7\">`): each one's data-* attributes, in page order. Rendering to the name draws in every one; rendering to `<name>#<index>` draws in one. From then on, the plugin hears the event \"slot:changed\" with { slot } when those slots come, go or change.",
      },
    },
    capability: () => "ui",
    call: (plugin, method, args, dispatch) => {
      if (method !== "matches" && method !== "slots") throw new Error(`page.${method} is not a method`);
      const id = base(plugin);
      if (method === "matches" && (typeof args[0] !== "string" || !remote.installed.get(id)?.manifest.places?.[args[0]])) throw new Error(`${id} has no place named ${String(args[0])}`);
      // A declared slot is named for the plugin that declared it: cookbook.recipe.actions.
      if (method === "slots" && (typeof args[0] !== "string" || !/^[a-z][a-z0-9-]*\.[\w.-]{1,120}$/.test(args[0]))) throw new Error(`A slot a plugin declares is named <plugin id>.<name>, not ${String(args[0])}`);
      // A tab-scoped plugin asks its own tab; a shared one, any tab with its app open.
      const tab = plugin.split("@")[1];
      const host = hosts.list.find((h) => (tab ? h.tab === tab : apps.linkedBy(h.tab)?.includes(id)));
      if (!host) throw new Error("No tab has this plugin's app open");
      return hosts.bridge("page", method, [id, args[0]], dispatch, host);
    },
  };
};

export default service("page", make);
