// Apps: a tab that opens an app.html tells the kernel which plugins the page
// links with <link rel="plugin">. The kernel runs each of them for as long
// as at least one tab has that app open, and stops it when the last one
// goes. These plugins aren't kept in the data folder: the app's files are
// where they live. Their data (collections, storage) is kept as usual.
//
// Two apps may link the same plugin; it runs once. A link whose plugin has
// the id of a different running plugin is refused, since ids are how
// permissions, data and views are tied to a plugin.

import type { Host, Hosts } from "./hosts";
import { readManifest } from "./manifest";
import type { RemotePlugins } from "./remote";
import { record } from "./trace";

type Link = { href: string; source: string };
type Opened = { href: string; id?: string; error?: string };

export function apps(remote: RemotePlugins, hosts: Hosts) {
  /** For each plugin an app linked: the tabs that have that app open. */
  const users = new Map<string, Set<string>>();

  async function openOne(host: Host, { href, source }: Link): Promise<Opened> {
    let id: string;
    try {
      id = readManifest(source).id;
    } catch (error) {
      return { href, error: error instanceof Error ? error.message : String(error) };
    }
    const running = remote.installed.get(id);
    if (running && running.source !== source) return { href, id, error: `Another plugin with the id “${id}” is already running` };
    if (!running) {
      const result = await remote.install(source, { origin: "app", href });
      if (!result.ok) return { href, error: result.error };
    }
    if (!users.has(id)) users.set(id, new Set());
    users.get(id)!.add(host.tab);
    return { href, id };
  }

  return {
    /** Starts the plugins a tab's app links, and tells the tab which ids they have. */
    async open(host: Host, links: Link[]): Promise<void> {
      const plugins = await Promise.all(links.map((link) => openOne(host, link)));
      record({ kind: "lifecycle", name: "app:open", detail: `${host.tab}: ${plugins.map((p) => p.id ?? `${p.href} (${p.error})`).join(", ")}` });
      if (hosts.list.includes(host)) hosts.send(host, { t: "opened", plugins });
    },

    /** A tab closed: stop the app plugins no open tab needs any more. */
    hostLeft(host: Host): void {
      for (const [id, tabs] of users) {
        if (!tabs.delete(host.tab) || tabs.size) continue;
        users.delete(id);
        if (remote.installed.get(id)?.origin === "app") remote.uninstall(id);
      }
    },
  };
}
