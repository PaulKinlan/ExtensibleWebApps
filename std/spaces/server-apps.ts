// On a space's server: the apps opened in the space, and their plugins that
// run there (`runs: "server"` or `"both"` in the manifest). A device that
// opens an app in the space says so (device.ts, as the sync message
// `app`); the space reads the app's app.html from the site, and installs and
// starts each plugin it links that runs on the server. They keep running with
// no app open anywhere, and start again when the space's kernel does.
//
// An agent file the app links (rel="agent") runs here only when it is for
// agents outside the app (`outside: true`, src/kernel/agents/file.ts): it opens
// the space's MCP door. An app's own agents run in the browser.
//
// Only an app's own plugins run here, the files the site serves: the
// author's, which the deployment chose to serve. A person's own plugins stay
// in their browser. The app's browser plugins don't run here, but their
// collections are registered, so a server plugin can read what they keep.
//
// Kept in the space's folder:
//   server/apps.json   the apps opened in the space

import { fromAgentFile, isAgentFile, isOutsideFile } from "../../src/kernel/agents/file";
import { readManifest } from "../../src/kernel/manifest";
import type { RemotePlugins } from "../../src/kernel/remote";
import type { Store } from "../../src/kernel/store";
import { record } from "../../src/kernel/trace";
import { checkApp } from "../../src/kernel/user-plugins";

const FILE = "server/apps.json";
const MAX_APPS = 50;
const LINK = /<link\b[^>]*>/gi;
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);

/** The plugin files an app.html links with <link rel="plugin"> (or, with `rels`, others), as absolute URLs on the site. */
export function pluginLinks(html: string, base: string, rels: string[] = ["plugin"]): string[] {
  const site = new URL(base).origin;
  const out: string[] = [];
  // A commented-out link is off, in the browser and here.
  for (const [tag] of html.replace(/<!--[\s\S]*?(?:-->|$)/g, "").matchAll(LINK)) {
    if (!rels.includes((attr(tag, "rel") ?? "").toLowerCase())) continue;
    const href = attr(tag, "href");
    if (!href) continue;
    const url = new URL(href, base);
    if (url.origin === site) out.push(url.href);
  }
  return out;
}

export function serverApps(
  remote: RemotePlugins,
  store: Store,
  origin: string,
  fetcher: (url: string) => Promise<Response> = (url) => fetch(url),
  /** Called when an app's plugins have been read: the collections the space knows of may have changed. */
  learned: () => void = () => {},
  /** Called with each of an app's plugins' manifests as it is read, whether or not it runs here (permissions.ts reads its collections' rules). */
  read: (manifest: ReturnType<typeof readManifest>) => void = () => {},
) {
  let apps: string[] = [];
  /** The apps whose plugins were started since the kernel started. */
  const started = new Set<string>();
  /** The plugin files read and installed since the kernel started, so a retry doesn't start them twice. */
  const loadedPlugins = new Set<string>();
  /** Starts under way, and when the last one finished. */
  const starting = new Set<Promise<void>>();
  let finished = 0;
  let isLoaded = false;
  const loaded = store.readJson<unknown>(FILE, []).then((saved) => {
    isLoaded = true;
    apps = Array.isArray(saved) ? saved.filter((a): a is string => typeof a === "string").slice(0, MAX_APPS) : [];
    for (const app of apps) void start(app);
  });

  /**
   * Starts an app's server plugins. Resolves to whether the app is there (its app.html was read). A plugin
   * that couldn't be read is tried again the next time a device opens the app; one that started isn't.
   */
  function start(app: string): Promise<boolean> {
    if (started.has(app)) return Promise.resolve(true);
    started.add(app);
    const run = startApp(app).then(
      (complete) => {
        if (!complete) started.delete(app);
        return true;
      },
      (error) => {
        // Not this time: the next device that opens it tries again.
        started.delete(app);
        record({ kind: "error", name: "server:app", detail: `${app}: ${error instanceof Error ? error.message : error}` });
        return false;
      },
    );
    const settled = run.then(() => {});
    starting.add(settled);
    void settled.finally(() => {
      starting.delete(settled);
      finished = Date.now();
    });
    return run;
  }

  /** Resolves to whether every plugin the app links could be read; throws if its app.html can't be. */
  async function startApp(app: string): Promise<boolean> {
    const base = `${origin.replace(/\/$/, "")}/${app}/`;
    const page = await fetcher(`${base}app.html`);
    if (!page.ok) throw new Error(`${app}/app.html: ${page.status}`);
    let complete = true;
    // Read every plugin first, then start the ones that run here together, so one that needs a service
    // another of them provides isn't refused for starting first (remote.expect).
    const starting: { href: string; source: string }[] = [];
    for (const href of pluginLinks(await page.text(), base, ["plugin", "agent"])) {
      if (loadedPlugins.has(href)) continue;
      const answer = await fetcher(href).catch((error) => new Response(String(error), { status: 599 }));
      if (!answer.ok) {
        complete = false;
        record({ kind: "error", name: "server:plugin", detail: `${href}: ${answer.status}` });
        continue;
      }
      let source = await answer.text();
      let manifest: ReturnType<typeof readManifest>;
      try {
        if (isAgentFile(href)) {
          // An app's own agent runs in the browser; only an outside agent file opens a door here.
          if (!isOutsideFile(source)) {
            loadedPlugins.add(href);
            continue;
          }
          source = fromAgentFile(source);
        }
        manifest = readManifest(source);
      } catch (error) {
        record({ kind: "error", name: "server:plugin", detail: `${href}: ${error instanceof Error ? error.message : error}` });
        continue;
      }
      loadedPlugins.add(href);
      read(manifest);
      const runs = manifest.runs;
      // A plugin that runs only in the browser still says which collections it keeps, so the space's server
      // plugins can read the records it writes there (a survey a member made, say). It isn't started here.
      if (runs !== "server" && runs !== "both") {
        remote.onManifest?.(manifest);
        continue;
      }
      starting.push({ href, source });
    }
    const started = remote.expect(starting.map((p) => p.source));
    try {
      for (const { href, source } of starting) {
        const result = await remote.install(source, { origin: "server", href });
        record({ kind: "lifecycle", name: "server:plugin", detail: `${app}: ${href}${result.ok ? "" : ` · ${result.error}`}` });
      }
    } finally {
      started();
      learned();
    }
    return complete;
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
      if (!apps.includes(folder) && apps.length >= MAX_APPS) return;
      // Kept only once its app.html is there, so names of apps that don't exist can't fill the list.
      if (!(await start(folder)) || apps.includes(folder) || apps.length >= MAX_APPS) return;
      apps.push(folder);
      await store.writeJson(FILE, apps);
    },
    /** The apps opened in the space. */
    list: async () => (await loaded, [...apps]),
    /** Whether any app's plugins are being started now (or the saved apps haven't been read yet). */
    starting: () => !isLoaded || starting.size > 0,
    /** When the last start finished (0 if none has). */
    finishedAt: () => finished,
    /** Resolves once the saved apps' plugins have been started; with the time the last start finished. */
    async settled(): Promise<number> {
      await loaded;
      while (starting.size) await Promise.all(starting);
      return finished;
    },
  };
}
