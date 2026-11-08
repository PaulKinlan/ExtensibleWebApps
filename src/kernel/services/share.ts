// The `share` service. Sharing out, and sharing in: a plugin can hand a
// link or some text to the system's share sheet (Web Share), and an app
// installed from the browser can be a place to share to (a share target), so
// a page shared from the browser lands in the reading list.
// Found by name: this file is src/kernel/services/share.ts, so it is `ctx.call("share", …)`.
//
// Sharing in needs no code of its own: an app's manifest names a screen to
// receive shares at, with the shared fields in its query —
//
//   "share_target": { "action": "share", "method": "GET",
//                     "params": { "title": "title", "text": "text", "url": "url" } }
//
// — so a share opens the app at /demos/reading-list/share?title=…&url=…, an
// address like any other screen (the router service). This service sees the
// tab arrive there, keeps what was shared for that tab, and raises
// `share:received`, which carries nothing: what was shared goes only to a plugin of that app, through take(). A plugin takes it with `share.take()`, once: taking it
// also moves the tab back to the app's own address, so a reload doesn't
// share it again. A plugin that starts after the tab opened still finds it.
//
// Sharing out opens the system's share sheet, which the browser allows only
// just after a click; where there is none (most desktop browsers), the link
// or text is copied instead, and the answer says so.

import { defineHook } from "../hooks";
import type { Host } from "../hosts";
import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";

defineHook("share:received", {
  mode: "emit",
  needs: "share",
  args: "{}",
  description: "Something was shared to an app from elsewhere (it is installed as a share target). Call share.take() to have it, if it was shared to your app. It carries nothing itself, as every plugin with `share` hears it.",
});

/** What a share carries: any of a title, some text and a link. */
interface Shared {
  title?: string;
  text?: string;
  url?: string;
}

/** The screen a manifest's share_target names. */
const SCREEN = "/share";
const LIMIT = 2000;

/** The share's fields that are text, each at most 2000 characters; undefined if there are none. */
function fieldsOf(value: unknown): Shared | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Shared = {};
  for (const key of ["title", "text", "url"] as const) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim() && v.length <= LIMIT) out[key] = v.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export default ({ root, hosts, apps }: Kernel): ServiceProvider => {
  /** What was shared into each tab and not taken yet, by tab. */
  const pending = new Map<string, Shared & { app?: string }>();

  root.on("router:changed", ({ app, tab, path, query }: { app?: string; tab: string; path: string; query: Record<string, string> }) => {
    if (path.replace(/\/$/, "") !== SCREEN) return;
    const shared = fieldsOf(query);
    if (!shared) return;
    pending.set(tab, { ...shared, app });
    root.emit({}, "share:received", {});
  });

  /** The tabs a plugin instance acts for: its own, or every tab with its app open (any, for a plugin no app links). */
  const tabsOf = (instance: string): Host[] => {
    const [id, tab] = instance.split("@");
    if (tab) return hosts.list.filter((h) => h.tab === tab);
    const near = hosts.list.filter((h) => apps.linkedBy(h.tab)?.includes(id));
    return near.length || apps.alongside(instance) ? near : [...hosts.list];
  };

  return {
    description: "Sharing a link or text out through the system's share sheet, and having what is shared to the app when it is installed as a share target.",
    methods: {
      send: {
        args: "({ title?, text?, url? })",
        returns: "{ ok, via: \"share\" | \"clipboard\" } or { ok: false, cancelled?, error? }",
        needs: "share",
        params: [{ name: "share", schema: { type: "object", description: "What to share: a title, some text and a link, any of them. A link may be a screen of the app, such as book/42." } }],
        description: "Opens the system's share sheet with a link or some text, or copies it where there is none. Only right after the person clicks, as the browser asks.",
      },
      take: {
        args: "()",
        returns: "{ title?, text?, url? } or null",
        needs: "share",
        params: [],
        description: "What was shared to the plugin's tab, once: it is gone after, and the tab moves back to the app's own address. null when nothing is waiting.",
      },
    },
    capability: () => "share",
    call: async (instance, method, args, dispatch) => {
      if (method === "take") {
        const host = tabsOf(instance).find((h) => pending.has(h.tab));
        if (!host) return null;
        const { app: _app, ...shared } = pending.get(host.tab)!;
        pending.delete(host.tab);
        // The tab leaves the share screen, so going back or reloading doesn't bring the share again.
        if (host.url?.path.replace(/\/$/, "") === SCREEN) await hosts.bridge("router", "go", ["/", true], dispatch, host).catch(() => {});
        return shared;
      }
      if (method !== "send") throw new Error(`share.${method} is not a method`);
      const shared = fieldsOf(args[0]);
      if (!shared) throw new Error("share.send takes { title?, text?, url? }, with at least one, each at most 2000 characters");
      const host = tabsOf(instance)[0];
      if (!host) throw new Error(`No tab has ${instance.split("@")[0]}'s app open`);
      return hosts.bridge("share", "send", [shared], dispatch, host);
    },
  };
};
