// The `plugins` service: a plugin's view of the other plugins in its app, and
// a switch for each. It is how a page can show its own parts and let the
// person turn them off and on again (std/switchboard.js, std/reset.js),
// without the workbench's plugins panel.
//
// A plugin only sees and switches the plugins its own app links, so it has
// to be tab-scoped: its tab says which app it is in. Turning one off is
// saved, like the plugins panel's switch, and stops its workers in every tab.

import { defineHook } from "./hooks";
import type { RemotePlugins, ServiceProvider } from "./remote";

type Apps = { linkedBy(tab: string): string[] | undefined };

defineHook("plugins:changed", {
  mode: "emit",
  needs: "plugins:read",
  args: "{ change, id }",
  description: "A plugin was installed, removed, or turned on or off (`change` is install, uninstall, enable or disable, and `id` is the plugin), or a tab opened its app (`change` is open, and `id` is the tab), so plugins.app() may answer differently.",
});

export function switches(root: any, remote: RemotePlugins, apps: Apps): { service: ServiceProvider; opened(tab: string): void } {
  // The plugins panel already listens for changes; this adds the hook alongside it.
  const before = remote.onChange;
  /** The trace of the plugins.setEnabled call being answered, so the change belongs to the action that asked for it. */
  let caller: string | undefined;
  /** Counts changes, so each one without a caller gets a trace id of its own. */
  let changes = 0;
  remote.onChange = (change, id) => {
    before?.(change, id);
    // The trace id names the change, so the trace tells one plugin's change from another's.
    root.emit({ trace: caller ?? `plugins:${change}:${id}:${++changes}` }, "plugins:changed", { change, id });
  };

  /** The plugins the caller's app links, or an error if it isn't in an app. */
  const appOf = (instance: string): string[] => {
    const tab = instance.split("@")[1];
    if (!tab) throw new Error('The plugins service needs scope: "tab", so it knows which app it is in');
    return apps.linkedBy(tab) ?? [];
  };

  const service: ServiceProvider = {
    description: "The plugins in the caller's app, and a switch for each. The caller must be tab-scoped; hear changes with the `plugins:changed` hook.",
    methods: {
      app: {
        args: "()",
        returns: "[{ id, name, description, enabled }]",
        needs: "plugins:read",
        description: "Every plugin the caller's app links, in the order its app.html lists them. Empty until the tab has opened its app.",
      },
      setEnabled: {
        args: "(id, enabled)",
        returns: "true if it changed",
        needs: "plugins:manage",
        description: "Turns one of the app's plugins on or off. Saved, and applies in every tab, as the plugins panel's switch does.",
      },
    },
    capability: (method) => (method === "setEnabled" ? "plugins:manage" : "plugins:read"),
    call: (instance, method, args, dispatch) => {
      const ids = appOf(instance);
      if (method === "app") {
        return ids.flatMap((id) => {
          const plugin = remote.installed.get(id);
          return plugin ? [{ id, name: plugin.manifest.name, description: plugin.manifest.description ?? "", enabled: plugin.enabled }] : [];
        });
      }
      if (method === "setEnabled") {
        const [id, enabled] = args;
        if (typeof id !== "string" || !ids.includes(id)) throw new Error(`${String(id)} isn't a plugin in this app`);
        // remote.setEnabled reports the change before its first await, so the caller's trace is set while it does.
        caller = dispatch?.trace;
        try {
          return remote.setEnabled(id, enabled === true);
        } finally {
          caller = undefined;
        }
      }
      throw new Error(`plugins.${method} is not a method`);
    },
  };

  return {
    service,
    /** A tab finished opening its app. Its tab-scoped plugins can start before that, and get an empty list until then. */
    opened(tab: string) {
      root.emit({ trace: `plugins:open:${tab}:${++changes}` }, "plugins:changed", { change: "open", id: tab });
    },
  };
}
