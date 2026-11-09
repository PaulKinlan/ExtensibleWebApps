// The `notify` service: the operating system's notifications, so a plugin
// can tell the person something while they are in another tab or app (the
// writer agent has finished, a long export is done). A plugin needs `notify`:
//
//   if ((await ctx.call("notify", "state")) === "default") … // offer a button that calls request()
//   await ctx.call("notify", "show", { title: "The writer is done", body: "3 edits to look at" });
//
// The browser asks the person once, after a click (request), and remembers
// the answer for the site. show() puts up one notification, from one tab with
// the plugin's app open, and only when nobody is looking at that app (unless
// `always`): someone looking at the page sees the plugin's own view instead.
// Clicking the notification brings that tab forward. The browser's part is a
// bridge (src/host/bridges/notify.ts), since Notification lives in pages.
//
// A kernel module (docs/layers.md): a site that lists `notify` in kernel.json has it, as `ctx.call("notify", …)`.

import type { Host } from "../../src/kernel/hosts";
import { service, type ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";
import type { Dispatch } from "../../src/shared/protocol";

const MAX_TITLE = 120;
const MAX_BODY = 400;
/** Notifications one plugin may show in a minute, so a plugin in a loop can't flood the person's screen. */
const PER_MINUTE = 6;

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { hosts, apps } = kernel;
  /** When each plugin's notifications in the last minute were shown. */
  const shown = new Map<string, number[]>();

  /** The tabs a plugin instance acts for: its own, or the tabs whose app links it. Never another app's tab. */
  const tabsOf = (instance: string): Host[] => {
    const [id, tab] = instance.split("@");
    if (tab) return hosts.list.filter((h) => h.tab === tab);
    return hosts.list.filter((h) => apps.linkedBy(h.tab)?.includes(id));
  };
  /** The tab to ask in: the one the person clicked in (an action's trace starts with its tab), or the plugin's first. */
  const tabFor = (instance: string, dispatch: Dispatch) => {
    const tabs = tabsOf(instance);
    const from = dispatch.trace?.split("-")[0];
    return tabs.find((h) => h.tab === from) ?? tabs[0];
  };
  const needTab = (host: Host | undefined) => {
    if (hosts.mode === "server") throw new Error("There are no notifications on a space's server");
    if (!host) throw new Error("No tab has this plugin's app open");
    return host;
  };

  return {
    description: "The operating system's notifications: tell the person something while they are away from the app.",
    methods: {
      state: { args: "()", params: [], returns: "\"granted\", \"denied\", \"default\" or \"unsupported\"", needs: "notify", description: "Whether the person allowed this site's notifications: \"default\" means they haven't been asked yet." },
      request: { args: "()", params: [], returns: "\"granted\", \"denied\", \"default\" or \"unsupported\"", needs: "notify", description: "Asks the person to allow notifications (call it right after a click in the app, from a button they pressed for it). The browser remembers the answer." },
      show: {
        args: "({ title, body?, tag?, always? })",
        params: [
          {
            name: "note",
            schema: {
              type: "object",
              properties: {
                title: { type: "string", description: "What happened, in a few words" },
                body: { type: "string", description: "A sentence more" },
                tag: { type: "string", description: "A notification with the same tag replaces this one" },
                always: { type: "boolean", description: "Show it even while the person is looking at the app" },
              },
              required: ["title"],
            },
          },
        ],
        returns: "true if it was shown",
        needs: "notify",
        description: `Shows a notification from one tab with the plugin's app open, when nobody is looking at the app (or \`always\`). False if the person hasn't allowed notifications, or is looking. At most ${PER_MINUTE} a minute for each plugin.`,
      },
    },
    capability: () => "notify",
    async call(instance, method, args, dispatch) {
      switch (method) {
        case "state":
          return hosts.bridge("notify", "state", [], dispatch, needTab(tabFor(instance, dispatch)));
        case "request":
          return hosts.bridge("notify", "request", [], dispatch, needTab(tabFor(instance, dispatch)));
        case "show": {
          const note = (args[0] ?? {}) as Record<string, unknown>;
          if (typeof note.title !== "string" || !note.title.trim()) throw new Error("notify.show needs a title");
          const tabs = tabsOf(instance);
          const host = needTab(tabs[0]);
          if (!note.always) {
            for (const tab of tabs) if (await hosts.bridge("notify", "visible", [], dispatch, tab).catch(() => false)) return false;
          }
          const plugin = instance.split("@")[0];
          const now = Date.now();
          const recent = (shown.get(plugin) ?? []).filter((at) => now - at < 60_000);
          if (recent.length >= PER_MINUTE) return false;
          // The slot is taken before asking the tab, so calls made at once can't all get past the limit.
          recent.push(now);
          shown.set(plugin, recent);
          const ok = (await hosts.bridge("notify", "show", [{ title: note.title.slice(0, MAX_TITLE), body: typeof note.body === "string" ? note.body.slice(0, MAX_BODY) : undefined, tag: typeof note.tag === "string" ? `${plugin}:${note.tag.slice(0, 60)}` : undefined }], dispatch, host).catch(() => false)) === true;
          if (!ok) {
            const slots = shown.get(plugin) ?? [];
            const at = slots.indexOf(now);
            if (at >= 0) slots.splice(at, 1);
          }
          return ok;
        }
      }
      throw new Error(`notify.${method} is not a method`);
    },
  };
};

export default service("notify", make);
