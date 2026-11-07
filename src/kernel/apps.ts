// Apps: a tab that opens an app.html tells the kernel which plugins the page
// links with <link rel="plugin">. The kernel runs each of them for as long
// as at least one tab has that app open, and stops it when the last one
// goes. These plugins aren't kept in the data folder: the app's files are
// where they live. Their data (collections, storage) is kept as usual.
//
// Two apps may link the same plugin; it runs once. A link whose plugin has
// the id of a different running plugin is refused, since ids are how
// permissions, data and views are tied to a plugin.

import type { Opened } from "../shared/protocol";
import type { Host, Hosts } from "./hosts";
import { readManifest } from "./manifest";
import type { RemotePlugins } from "./remote";
import { record } from "./trace";

type Link = { href: string; source: string };

export function apps(remote: RemotePlugins, hosts: Hosts, isOff: (id: string) => Promise<boolean>) {
  /** For each plugin an app linked: the tabs that have that app open. */
  const users = new Map<string, Set<string>>();
  /** For each tab with an app open: every plugin id its app.html links, including ones that failed to start. */
  const linked = new Map<string, Set<string>>();
  /** Installs under way, so two tabs opening the same app share one. */
  const installing = new Map<string, Promise<string | undefined>>();

  /** Stops an app plugin once no open tab needs it. */
  function release(id: string, tab: string): void {
    const tabs = users.get(id);
    if (!tabs?.delete(tab) || tabs.size) return;
    users.delete(id);
    if (remote.installed.get(id)?.origin === "app") remote.uninstall(id);
  }

  /** Installs and starts an app plugin; resolves to an error, or undefined if it runs (or is off by choice). */
  async function start(id: string, source: string, href: string): Promise<string | undefined> {
    // Turning a plugin off in the workbench is saved; reopening its app keeps it off.
    const enabled = !(await isOff(id));
    const result = await remote.install(source, { origin: "app", href, enabled });
    if (!result.ok) return result.error;
    if (enabled && !result.started) return "It didn't start; the trace says why";
    return undefined;
  }

  async function openOne(host: Host, { href, source }: Link): Promise<Opened> {
    let id: string;
    try {
      id = readManifest(source).id;
    } catch (error) {
      return { href, error: error instanceof Error ? error.message : String(error) };
    }
    const running = remote.installed.get(id);
    if (running && running.source !== source) return { href, id, error: `Another plugin with the id “${id}” is already running` };
    // The tab counts as a user before anything is awaited, so a tab that
    // closes while the plugin starts still lets it stop.
    if (!linked.has(host.tab)) linked.set(host.tab, new Set());
    linked.get(host.tab)!.add(id);
    if (!users.has(id)) users.set(id, new Set());
    users.get(id)!.add(host.tab);
    if (running && !installing.has(id)) return { href, id };

    let pending = installing.get(id);
    if (!pending) {
      pending = start(id, source, href).finally(() => installing.delete(id));
      installing.set(id, pending);
    }
    const error = await pending;
    if (error) {
      release(id, host.tab);
      return { href, id, error };
    }
    // Every tab using it closed while it started, before it was installed: stop it now.
    if (!users.has(id) && remote.installed.get(id)?.origin === "app") remote.uninstall(id);
    return { href, id };
  }

  return {
    /**
     * Starts the plugins a tab's app links, and tells the tab which ids they have. A tab may open its
     * app again (after the person turns a user plugin on or off): plugins it no longer links stop, unless
     * another tab still needs them. `describe` adds what the tab needs to know about each plugin.
     */
    async open(host: Host, links: Link[], describe: (opened: Opened) => Opened = (o) => o): Promise<void> {
      const before = new Set(linked.get(host.tab));
      linked.set(host.tab, new Set());
      const plugins = await Promise.all(links.map((link) => openOne(host, link)));
      const now = linked.get(host.tab)!;
      for (const id of before) if (!now.has(id)) release(id, host.tab);
      record({ kind: "lifecycle", name: "app:open", detail: `${host.tab}: ${plugins.map((p) => p.id ?? `${p.href} (${p.error})`).join(", ")}` });
      if (hosts.list.includes(host)) hosts.send(host, { t: "opened", plugins: plugins.map(describe) });
    },

    /** The plugins the app open in `tab` links, by id. */
    /** Undefined until the tab has opened an app (and for the workbench, which opens none). */
    linkedBy(tab: string): string[] | undefined {
      const ids = linked.get(tab);
      return ids && [...ids];
    },

    /** A tab closed: stop the app plugins no open tab needs any more. */
    hostLeft(host: Host): void {
      linked.delete(host.tab);
      for (const id of [...users.keys()]) release(id, host.tab);
    },
  };
}
