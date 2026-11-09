// The `launch` service: files opened with an app. An app installed from the
// browser can be where a kind of file opens ("Open with Reading list" on a
// PDF): its manifest names the screen they open at and the types it takes —
//
//   "file_handlers": [{ "action": "open",
//                       "accept": { "application/pdf": [".pdf"], "application/epub+zip": [".epub"] } }]
//
// — so opening a file starts the app at /demos/reading-list/open, a screen
// like any other (the router service), and the browser hands the page the
// files (its launch queue: src/host/bridges/launch.ts). This service sees a
// tab arrive at /open and raises `launch:received`, which carries nothing:
// the files go only to a plugin of that app, through take(), once. Taking them
// also moves the tab back to the app's own address, so a reload doesn't open
// them again. A plugin that starts after the tab opened still finds them.
// A kernel module (docs/layers.md): a site that lists `launch` in kernel.json has it, as `ctx.call("launch", …)`.
//
// Sharing a page to an app is the share service's (std/share/module.ts); this is its twin for files.

import type { Host } from "../../src/kernel/hosts";
import { service, type ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";

/** The screen a manifest's file_handlers action names. */
const SCREEN = "/open";

/** A file opened with the app, as the page read it. */
export interface Launched {
  name: string;
  type: string;
  size: number;
  lastModified: number;
  /** Its text, for a text file (text/*, JSON, CSV, Markdown) of at most a few megabytes. */
  text?: string;
}

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { root, hosts, apps } = kernel;
  kernel.hook("launch:received", {
    mode: "emit",
    needs: "launch",
    args: "{}",
    description: "Files were opened with an app (it is installed, and its manifest has file_handlers). Call launch.take() to have them, if they were opened with your app. It carries nothing itself, as every plugin with `launch` hears it.",
  });
  /** Tabs that opened at the screen and haven't had their files taken, with their app. */
  const pending = new Map<string, string | undefined>();

  root.on("router:changed", ({ app, tab, path }: { app?: string; tab: string; path: string }) => {
    if (path.replace(/\/$/, "") !== SCREEN) return;
    pending.set(tab, app);
    root.emit({}, "launch:received", {});
  });

  /** The tabs a plugin instance acts for: its own, or every tab with its app open. */
  const tabsOf = (instance: string): Host[] => {
    const [id, tab] = instance.split("@");
    if (tab) return hosts.list.filter((h) => h.tab === tab);
    const near = hosts.list.filter((h) => apps.linkedBy(h.tab)?.includes(id));
    return near.length || apps.alongside(instance) ? near : [...hosts.list];
  };

  return {
    description: "Files opened with the app, when it is installed and its manifest has file_handlers: what each is, and a text file's text.",
    methods: {
      take: {
        args: "()",
        returns: "[{ name, type, size, lastModified, text? }]",
        needs: "launch",
        params: [],
        description: "The files opened with the plugin's tab, once: they are gone after, and the tab moves back to the app's own address. text is there for a text file (text/*, JSON, CSV, Markdown) of at most 5 MB. An empty list when nothing is waiting.",
      },
    },
    capability: () => "launch",
    call: async (instance, method, _args, dispatch) => {
      if (method !== "take") throw new Error(`launch.${method} is not a method`);
      const host = tabsOf(instance).find((h) => pending.has(h.tab));
      if (!host) return [];
      pending.delete(host.tab);
      const files = (await hosts.bridge("launch", "take", [], dispatch, host)) as Launched[];
      // The tab leaves the open screen, so going back or reloading doesn't open the files again.
      if (host.url?.path.replace(/\/$/, "") === SCREEN) await hosts.bridge("router", "go", ["/", true], dispatch, host).catch(() => {});
      return files;
    },
  };
};

export default service("launch", make);
