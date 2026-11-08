// On a space's server: the apps opened in the space, and their plugins that
// run there (`runs: "server"` or `"both"` in the manifest). A device that
// opens an app in the space says so (sync-device.ts, as the sync message
// `app`); the space reads the app's app.html from the site, and installs and
// starts each plugin it links that runs on the server. They keep running with
// no app open anywhere, and start again when the space's kernel does.
//
// Only an app's own plugins run here, the files the site serves: the
// author's, which the deployment chose to serve. A person's own plugins stay
// in their browser.
//
// Kept in the space's folder:
//   server/apps.json   the apps opened in the space

import { readManifest } from "./manifest";
import type { RemotePlugins } from "./remote";
import type { Store } from "./store";
import { record } from "./trace";
import { checkApp } from "./user-plugins";

const FILE = "server/apps.json";
const MAX_APPS = 50;
const LINK = /<link\b[^>]*>/gi;
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);

/** The plugin files an app.html links with <link rel="plugin">, as absolute URLs on the site. */
export function pluginLinks(html: string, base: string): string[] {
  const site = new URL(base).origin;
  const out: string[] = [];
  for (const [tag] of html.matchAll(LINK)) {
    if ((attr(tag, "rel") ?? "").toLowerCase() !== "plugin") continue;
    const href = attr(tag, "href");
    if (!href) continue;
    const url = new URL(href, base);
    if (url.origin === site) out.push(url.href);
  }
  return out;
}

export function serverApps(remote: RemotePlugins, store: Store, origin: string, fetcher: (url: string) => Promise<Response> = (url) => fetch(url)) {
  let apps: string[] = [];
  /** The apps whose plugins were started since the kernel started. */
  const started = new Set<string>();
  /** Starts under way, and when the last one finished. */
  const starting = new Set<Promise<void>>();
  let finished = 0;
  const loaded = store.readJson<unknown>(FILE, []).then((saved) => {
    apps = Array.isArray(saved) ? saved.filter((a): a is string => typeof a === "string").slice(0, MAX_APPS) : [];
    for (const app of apps) void start(app);
  });

  function start(app: string): Promise<void> {
    if (started.has(app)) return Promise.resolve();
    started.add(app);
    const run = startApp(app).finally(() => {
      starting.delete(run);
      finished = Date.now();
    });
    starting.add(run);
    return run;
  }

  async function startApp(app: string): Promise<void> {
    const base = `${origin.replace(/\/$/, "")}/${app}/`;
    try {
      const page = await fetcher(`${base}app.html`);
      if (!page.ok) throw new Error(`${app}/app.html: ${page.status}`);
      for (const href of pluginLinks(await page.text(), base)) {
        const answer = await fetcher(href);
        if (!answer.ok) {
          record({ kind: "error", name: "server:plugin", detail: `${href}: ${answer.status}` });
          continue;
        }
        const source = await answer.text();
        let runs: string | undefined;
        try {
          runs = readManifest(source).runs;
        } catch (error) {
          record({ kind: "error", name: "server:plugin", detail: `${href}: ${error instanceof Error ? error.message : error}` });
          continue;
        }
        if (runs !== "server" && runs !== "both") continue;
        const result = await remote.install(source, { origin: "server", href });
        record({ kind: "lifecycle", name: "server:plugin", detail: `${app}: ${href}${result.ok ? "" : ` · ${result.error}`}` });
      }
    } catch (error) {
      // Not this time: the next device that opens it tries again.
      started.delete(app);
      record({ kind: "error", name: "server:app", detail: `${app}: ${error instanceof Error ? error.message : error}` });
    }
  }

  return {
    /** A device opened `app` in the space. */
    async use(app: unknown): Promise<void> {
      await loaded;
      let folder: string;
      try {
        folder = checkApp(app);
      } catch {
        return;
      }
      if (!apps.includes(folder)) {
        if (apps.length >= MAX_APPS) return;
        apps.push(folder);
        await store.writeJson(FILE, apps);
      }
      await start(folder);
    },
    /** The apps opened in the space. */
    list: async () => (await loaded, [...apps]),
    /** Resolves once the saved apps' plugins have been started; with the time the last start finished. */
    async settled(): Promise<number> {
      await loaded;
      while (starting.size) await Promise.all(starting);
      return finished;
    },
  };
}
