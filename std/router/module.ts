// The `router` service. A screen for every address: the reading list opened
// at /demos/reading-list/book/42 shows the screen `/book/42`, so a person can
// bookmark or share it, and back and forward move between screens.
// A kernel module (docs/layers.md): a site that lists `router` in kernel.json has it, as `ctx.call("router", …)`.
//
// A screen is an address inside the app's folder. The service worker answers
// it with the app's page (sw/routes/apps.js), and the page moves between
// screens without loading again (src/host/router.ts). The tab sends its
// screen when the app opens and whenever it changes (links to screens, back
// and forward, `router.go`). The kernel keeps it with the tab and raises
// `router:changed`, and plugins with the `router` permission listen to it and
// read `router.current()`.
//
// A screen belongs to one tab, so a plugin that draws a screen is usually
// `scope: "tab"`: each tab's instance draws what its own tab shows. A shared
// plugin gets the screen of the tab with its app open that changed most
// recently.

import type { Host } from "../../src/kernel/hosts";
import { service, type ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";

const base = (instance: string) => instance.split("@")[0];

type Query = Record<string, string>;

/** A screen the kernel keeps: a path, and at most 50 query values of text. `router.go` holds to the same, so the page and the kernel can't disagree. */
function isScreen(path: unknown, fields: [string, unknown][]): path is string {
  return typeof path === "string" && path.startsWith("/") && path.length <= 2000 && fields.length <= 50 && fields.every(([, v]) => typeof v === "string" && v.length <= 2000);
}

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { root, hosts, apps } = kernel;
  kernel.hook("router:changed", {
    mode: "emit",
    needs: "router",
    args: "{ app, tab, path, query }",
    description: "A tab moved to another screen of its app: a link to one, back or forward, or router.go. Read router.current() for the screen your instance shows.",
  });
  // The tab's address changed: kernel.ts hears it from the page and passes it on as internal/url, which only
  // trusted code hears. Anything that isn't a path and some text values is ignored.
  root.on("internal/url", (host: Host, path: unknown, rawQuery: unknown, app?: string) => {
    const fields = rawQuery && typeof rawQuery === "object" ? Object.entries(rawQuery as Record<string, unknown>) : [];
    if (!isScreen(path, fields)) return;
    const query = Object.fromEntries(fields) as Query;
    const before = host.url;
    host.url = { path, query, at: Date.now() };
    if (before && before.path === path && JSON.stringify(before.query) === JSON.stringify(query)) return;
    root.emit({}, "router:changed", { app, tab: host.tab, path, query });
  });

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
    description: "The screen an app's tab shows, from its address (app/book/42), so screens can be bookmarked and shared, and back and forward work.",
    methods: {
      current: {
        args: "()",
        returns: "{ tab, path, query }",
        needs: "router",
        params: [],
        description: "The screen the plugin's tab shows: the reading list at `/demos/reading-list/book/42?tab=notes` is `{ path: \"/book/42\", query: { tab: \"notes\" } }`. The app's own address is `/`.",
      },
      go: {
        args: "(path, { replace? }?)",
        returns: "true",
        needs: "router",
        params: [{ name: "path", schema: { type: "string", description: "The screen, starting with /, with ?query if it has one: /book/42" } }],
        description: "Moves the plugin's tab to another screen without loading the page, as a link to it would. With `replace`, back skips the screen it leaves.",
      },
    },
    capability: () => "router",
    call: async (instance, method, args, dispatch) => {
      const host = tabOf(instance);
      if (method === "current") return { tab: host.tab, path: host.url?.path ?? "/", query: host.url?.query ?? {} };
      if (method !== "go") throw new Error(`router.${method} is not a method`);
      const [path, options] = args as [unknown, { replace?: unknown } | undefined];
      const [screen, search] = typeof path === "string" ? [path.split("?")[0], path.slice(path.split("?")[0].length + 1)] : [path, ""];
      if (typeof path !== "string" || !String(screen).startsWith("/")) throw new Error("router.go takes a path that starts with /");
      if (!isScreen(screen, [...new URLSearchParams(search)])) throw new Error("router.go takes a path of at most 2000 characters, with at most 50 query values of 2000");
      await hosts.bridge("router", "go", [path, !!options?.replace], dispatch, host);
      return true;
    },
  };
};

export default service("router", make);
