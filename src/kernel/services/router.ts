// The `router` service. A screen for every address: an app's tab at
// `/demos/reading-list/#/book/42` shows the screen `/book/42`, so a person can
// bookmark or share it, and back and forward move between screens.
// Found by name: this file is src/kernel/services/router.ts, so it is `ctx.call("router", …)`.
//
// The screen lives in the address's hash. That works on any server, and for
// someone opening a shared link before the service worker is installed. The
// tab sends its screen when the app opens and whenever it changes (links,
// back and forward, `router.go`). The kernel keeps it with the tab and raises
// `router:changed`, and plugins with the `router` permission listen to it and
// read `router.current()`.
//
// A screen belongs to one tab, so a plugin that draws a screen is usually
// `scope: "tab"`: each tab's instance draws what its own tab shows. A shared
// plugin gets the screen of the tab with its app open that changed most
// recently.

import { defineHook } from "../hooks";
import type { Host } from "../hosts";
import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";

const base = (instance: string) => instance.split("@")[0];

defineHook("router:changed", {
  mode: "emit",
  needs: "router",
  args: "{ app, tab, path, query }",
  description: "A tab moved to another screen of its app: a link to #/…, back or forward, or router.go. Read router.current() for the screen your instance shows.",
});

type Query = Record<string, string>;

/** Set when the service is made: what happens when a tab says where it is. */
let changed: ((host: Host, path: string, query: Query, app?: string) => void) | undefined;

/** The tab's address changed (kernel.ts hears it from the page). Anything that isn't a path and some text values is ignored. */
export function routed(host: Host, path: unknown, query: unknown, app?: string): void {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 2000) return;
  const fields = query && typeof query === "object" ? Object.entries(query as Record<string, unknown>) : [];
  if (fields.length > 50 || fields.some(([, v]) => typeof v !== "string" || v.length > 2000)) return;
  changed?.(host, path, Object.fromEntries(fields) as Query, app);
}

export default ({ root, hosts, apps }: Kernel): ServiceProvider => {
  changed = (host, path, query, app) => {
    const before = host.url;
    host.url = { path, query, at: Date.now() };
    if (before && before.path === path && JSON.stringify(before.query) === JSON.stringify(query)) return;
    root.emit({}, "router:changed", { app, tab: host.tab, path, query });
  };

  /** The tab a plugin instance draws for: its own, or for a shared plugin, the one whose screen changed last among the tabs with its app open. */
  function tabOf(instance: string): Host {
    const [id, tab] = instance.split("@");
    let candidates = hosts.list.filter((h) => (tab ? h.tab === tab : apps.linkedBy(h.tab)?.includes(id)));
    // A plugin no app links (one installed on the workbench) goes with whichever tab moved last.
    if (!tab && !candidates.length && !apps.alongside(instance)) candidates = [...hosts.list];
    const host = candidates.sort((a, b) => (b.url?.at ?? 0) - (a.url?.at ?? 0))[0];
    if (!host) throw new Error(`No tab has ${base(instance)}'s app open`);
    return host;
  }

  return {
    description: "The screen an app's tab shows, from its address (#/book/42), so screens can be bookmarked and shared, and back and forward work.",
    methods: {
      current: {
        args: "()",
        returns: "{ tab, path, query }",
        needs: "router",
        description: "The screen the plugin's tab shows: `#/book/42?tab=notes` is `{ path: \"/book/42\", query: { tab: \"notes\" } }`. With no hash, the path is `/`.",
      },
      go: {
        args: "(path, { replace? }?)",
        returns: "true",
        needs: "router",
        description: "Moves the plugin's tab to another screen, as a link to #/… would. With `replace`, back skips the screen it leaves.",
      },
    },
    capability: () => "router",
    call: async (instance, method, args, dispatch) => {
      const host = tabOf(instance);
      if (method === "current") return { tab: host.tab, path: host.url?.path ?? "/", query: host.url?.query ?? {} };
      if (method !== "go") throw new Error(`router.${method} is not a method`);
      const [path, options] = args as [unknown, { replace?: unknown } | undefined];
      if (typeof path !== "string" || !path.startsWith("/") || path.length > 2000) throw new Error("router.go takes a path that starts with /");
      await hosts.bridge("router", "go", [path, !!options?.replace], dispatch, host);
      return true;
    },
  };
};
