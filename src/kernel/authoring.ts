// The `authoring` service: what a plugin editor (std/plugin-editor.js) needs
// to help a person write a plugin before it runs. It reads the code of the
// plugins in the caller's app, reads starting files that sit next to the
// editor, and checks a draft's manifest, saying in plain words what each
// permission it asks for would let it do.
//
// Saving puts the draft with the person's own plugins for the app
// (user-plugins.ts), and turns it on. The person sees the code and what it
// asks for first, on a review card, every time; a plugin can't save one
// without them.
//
// It is also everything the Customize panel does with the person's own
// plugins, so a plugin can do it too: add one from this site (the registry
// at /packages/), turn one on or off, remove it, and in a space, share it
// with the other members or stop sharing it. Each change but on and off
// waits for the person to accept a review card that shows the code; on and
// off need plugins:manage, as switching the app's own plugins does.
//
// Before a new or changed plugin is shown to the person, plugins:beforeAdd
// runs with its code and what it asks for: a plugin or an agent that checks
// plugins (a security reviewer) may stop it with { block: reason }, which
// the caller gets back as the error, or let it through to the review.

import { defineHook } from "./hooks";
import { readManifest } from "./manifest";
import type { Dispatch } from "../shared/protocol";
import type { RemotePlugins, ServiceProvider } from "./remote";
import { allowed, type Outcome, type Request } from "./review";
import type { Store } from "./store";
import type { UserPlugin, UserPlugins } from "./user-plugins";

type Apps = { linkedBy(tab: string): string[] | undefined; tabsWith?(id: string): string[] };

defineHook("plugins:beforeAdd", {
  mode: "serial",
  timeoutMs: 2000,
  agentTimeoutMs: 20_000,
  onFailure: "open",
  args: "{ app, id, name, permissions, code, how, by }",
  description:
    "Before one of the person's own plugins is added or changed (how: save, add or pick), and before they see its review card: a checker gets its code and the permissions it asks for, and may return { block: reason } to stop it. by is the plugin that asked. It carries the code, so listening needs hook:intercept:plugins:beforeAdd.",
});

/** What saving needs from the kernel: the person's plugins, the app open in each tab, and the review. */
export interface Saving {
  store: Store;
  userAdded: UserPlugins;
  /** The folder of the app open in a tab, if it has one. */
  appIn(tab: string): string | undefined;
  ask(request: Request, dispatch: Dispatch): Promise<Outcome>;
  /** Starts the app again in every tab that has it open, so a saved plugin runs. */
  reopen(app: string): Promise<void>;
  /** Clears a plugin's saved "off", so saving one the person had switched off runs it again. */
  turnOn(ids: string[]): Promise<void>;
  /** In a kernel for a space: its plugins on this device (std/spaces/plugins.ts), which the person's own can be shared with. */
  shared(): Sharing | undefined;
  /** The site's address, where the plugin registry is (/packages/index.json). */
  origin: string;
  /** The services this kernel has now, from a module or a running plugin: a registry package that needs one adds no provider for it. */
  services(): string[];
  /** Asks the page in a tab (src/host/bridges/customize.ts). */
  page(tab: string, method: string, args: unknown[], dispatch: Dispatch): Promise<unknown>;
  /** Lets a plugin into a place the app's author locked, or locks it again, and opens the app again so it shows. */
  unlock(app: string, plugin: string, place: string, on: boolean): Promise<void>;
  /** Runs plugins:beforeAdd: a checker's { block: reason }, or nothing. */
  check?(value: { app: string; id: string; name: string; permissions: string[]; code: string; how: string; by: string }, dispatch: Dispatch): Promise<unknown>;
}

/** A plugin in the registry's index (packages/index.json, built by scripts/packages.mjs). */
interface Package {
  id: string;
  name: string;
  description: string;
  href: string;
  permissions: string[];
  provides: string[];
  services: string[];
}

/** Sharing the person's own plugins with a space. */
export interface Sharing {
  mark<T extends { id?: string }>(app: string, plugins: T[]): Promise<(T & { shared: boolean })[]>;
  share(app: string, id: string): Promise<boolean>;
  unshare(app: string, id: string): Promise<boolean>;
}

/** The longest file `file()` reads, and the longest draft `check()` takes. */
const MAX = 100_000;

/** Where a module's first statement starts: after the comments and blank lines at its top. */
function firstStatement(code: string): number {
  let i = 0;
  for (;;) {
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code.startsWith("//", i)) i = code.indexOf("\n", i) < 0 ? code.length : code.indexOf("\n", i);
    else if (code.startsWith("/*", i)) i = code.indexOf("*/", i) < 0 ? code.length : code.indexOf("*/", i) + 2;
    else return i;
  }
}

/**
 * A copy of a plugin that can run beside it: a new id and name in its manifest, and its template files
 * named from where the original lives, since the copy is kept somewhere else. Checked by reading the
 * manifest back, so a manifest written some unusual way is refused rather than copied wrong.
 */
export function copyOf(code: string, href: string | undefined): { id: string; name: string; code: string } {
  const original = readManifest(code);
  const id = `${original.id}-copy`.slice(0, 64);
  const name = `${original.name} (copy)`.replace(/["'\\]/g, "");
  const start = firstStatement(code);
  const field = (key: string) => new RegExp(`(?<![\\w$])(["']?)${key}\\1\\s*:\\s*(["'])(?:\\\\.|(?!\\2).)*\\2`);
  let manifest = code.slice(start);
  manifest = manifest.replace(field("id"), (_m, k, q) => `${k}id${k}: ${q}${id}${q}`);
  manifest = manifest.replace(field("name"), (_m, k, q) => `${k}name${k}: ${q}${name}${q}`);
  let copy = code.slice(0, start) + manifest;
  if (href) {
    const folder = new URL(".", href).pathname;
    copy = copy.replace(/\bviews\(\s*(["'])([^"'/:][^"']*\.html)\1/g, (_m, q, file) => `views(${q}${folder}${file}${q}`);
  }
  const back = readManifest(copy);
  if (back.id !== id || back.name !== name) throw new Error("Couldn't give the copy an id of its own; change `id` in its manifest by hand");
  return { id, name, code: copy };
}

/** What a permission lets a plugin do, in words a person who doesn't code can weigh. */
export function explain(permission: string): string {
  const [kind, verb, ...rest] = permission.split(":");
  const what = rest.join(":");
  if (permission === "ui") return "Draw on this page.";
  if (permission === "network") return "Connect to sites on the internet.";
  if (kind === "data" && verb === "read") return `Read the ${what} records, and hear when they change.`;
  if (kind === "data" && verb === "write") return `Change the ${what} records. Unless it made them, you are asked first each time.`;
  if (kind === "hook" && verb === "listen") return `Hear ${what}.`;
  if (kind === "hook" && verb === "intercept") return `Change or stop ${what} before it happens.`;
  if (permission === "plugins:read") return "See which plugins this page has, which are on, and their code.";
  if (permission === "plugins:manage") return "Turn this page's plugins on and off.";
  if (permission === "plugins:author") return "Read the code of this page's plugins, and add, change, remove or share your own. Each change is shown to you first.";
  if (kind === "provide" && verb) return `Answer every call this page's plugins make to the ${[verb, what].filter(Boolean).join(":")} service.`;
  if (permission === "debug:read") return "See everything every plugin does, as the debug console does.";
  if (permission === "live") return "Send and hear live messages with the other people in this space and its server, such as a game's moves.";
  return `Use ${permission}.`;
}

export function authoring(remote: RemotePlugins, apps: Apps, saving: Saving): ServiceProvider {
  /**
   * The caller's tab, or an error: the editor works on the app open in one tab. A shared plugin, such as
   * an agent (std/agents/builder.agent.md), works on the app that links it, through any tab that has it open.
   */
  const tabOf = (instance: string): string => {
    const tab = instance.split("@")[1] ?? apps.tabsWith?.(instance)[0];
    if (!tab) throw new Error('The authoring service needs scope: "tab", or an app open that links the caller, so it knows which app it is in');
    return tab;
  };
  const appOf = (tab: string): string => {
    const app = saving.appIn(tab);
    if (!app) throw new Error("This page has no app folder, so it can't keep plugins of your own");
    return app;
  };
  /** The plugins with a save or removal waiting for the person, so a second click doesn't ask again. */
  const asking = new Set<string>();
  /** Why a draft can't own the collections it declares: another plugin already does. */
  const takenCollection = (m: { id: string; collections?: Record<string, unknown> }): string | undefined => {
    for (const name of Object.keys(m.collections ?? {})) {
      const owner = remote.collectionOwner?.(name);
      if (owner && owner !== m.id) {
        const who = remote.installed.get(owner)?.manifest.name ?? owner;
        return `${who} already owns the ${name} collection, so this plugin can't declare it too. Take ${name} out of \`collections\`, and ask for data:read:${name} and data:write:${name} in \`permissions\` instead.`;
      }
    }
    return undefined;
  };
  const words = (permissions: string[]) => (permissions.length ? permissions.map(explain).join(" ") : "Nothing: it can't draw, read or change anything.");

  return {
    description: "The person's own plugins for an app, for a plugin editor, a Customize panel or an agent: reads the code of the plugins in the caller's app and files next to the caller, checks a draft's manifest, and adds, saves, turns on and off, removes and shares the person's own plugins. Every change but on and off waits for them to accept a review. The caller must be tab-scoped, or linked by an open app.",
    methods: {
      source: {
        args: "(id)",
        returns: "{ id, name, code }",
        needs: "plugins:read",
        description: "The code of a plugin the caller's app links, or of one of the person's own for it, on or off.",
        params: [{ name: "id", schema: { type: "string", description: "The plugin's id" } }],
      },
      copy: {
        args: "(id)",
        returns: "{ id, name, code }",
        needs: "plugins:author",
        description: "A copy of a plugin the caller's app links, with an id and name of its own so it can run beside the original, and its templates read from where the original lives.",
      },
      mine: {
        args: "()",
        returns: "[{ id, name, description, permissions, places, on, shared, error? }]",
        needs: "plugins:author",
        description: "The person's own plugins for the caller's app. In a space, shared says which are the space's plugins. error says why one can't run: its manifest can't be read, or it needs a service nothing here provides (and which registry package does).",
        params: [],
      },
      add: {
        args: "(url)",
        returns: "{ ok: true, id } or { ok: false, error }",
        needs: "plugins:author",
        description: "Adds a plugin from this site, such as one in the registry at /packages/, to the person's own for the caller's app, with the files its manifest lists, once they accept a review that shows its code and what it asks for. It is added off: turn it on with turn().",
        params: [{ name: "url", schema: { type: "string", description: "The plugin's .js file on this site: /packages/clock/clock.js" } }],
      },
      turn: {
        args: "(id, on)",
        returns: "{ ok: true, also: [{ id, name }] } or { ok: false, error }",
        needs: "plugins:manage",
        description: "Turns one of the person's own plugins for the caller's app on or off. Turning one on turns on the person's plugins that provide the services it needs, and turning one off turns off theirs that need a service only it provides: also lists those. The app's own plugins are switched with plugins.setEnabled.",
        params: [
          { name: "id", schema: { type: "string", description: "The id of one of the person's own plugins" } },
          { name: "on", schema: { type: "boolean", description: "true to turn it on, false to turn it off" } },
        ],
      },
      page: {
        args: "()",
        returns: "{ space, places: [{ plugin, name, at, put, each, state, matches, fragile }], running: [{ id, name, user, unlocked }], samples: [{ href, title }], inspect }",
        needs: "plugins:read",
        description: "The caller's page as Customize shows it: whether it is in a space, how each plugin's places went (drawn, waiting, declined, locked, no match), which plugins run and which locked places each was let into, the samples the app offers (link rel=plugin-sample), and whether it has inspect mode.",
        params: [],
      },
      packages: {
        args: "()",
        returns: "[{ id, name, description, href, permissions, added, linked, adds: [href] }]",
        needs: "plugins:read",
        description: "The site's plugin registry (/packages/): each package, whether the person has added it to this app, whether the app links it already (linked), and what adding it adds, in order: first the packages that provide services it needs that aren't here yet, then itself.",
        params: [],
      },
      pick: {
        args: "()",
        returns: "{ ok: true, ids } or { ok: false, error }",
        needs: "plugins:author",
        description: "Opens the file chooser, right after the person clicks, and adds the plugin they pick (with any files it lists) to their own for the caller's app, once they accept a review of its code. It is added off.",
        params: [],
      },
      unlock: {
        args: "(plugin, place)",
        returns: "{ ok: true } or { ok: false, error }",
        needs: "plugins:author",
        description: "Lets a plugin into a part of the page the app's author locked, once the person accepts a review that says so.",
      },
      lock: {
        args: "(plugin, place)",
        returns: "{ ok: true }",
        needs: "plugins:author",
        description: "Locks a part of the page again, for a plugin that was let into it.",
      },
      inspect: {
        args: "()",
        returns: "true",
        needs: "plugins:read",
        description: "Starts the page's inspect mode, where the person points at a part to see which plugin drew it.",
        params: [],
      },
      share: {
        args: "(id)",
        returns: "{ ok: true } or { ok: false, error }",
        needs: "plugins:author",
        description: "In a space: shares one of the person's own plugins with the other members, once they accept a review that shows its code. It reaches the others' devices turned off.",
        params: [{ name: "id", schema: { type: "string", description: "The id of one of the person's own plugins" } }],
      },
      unshare: {
        args: "(id)",
        returns: "{ ok: true } or { ok: false, error }",
        needs: "plugins:author",
        description: "In a space: stops sharing a space plugin, once the person accepts a review. It goes from the other members' devices and stays here as theirs.",
        params: [{ name: "id", schema: { type: "string", description: "The id of a plugin shared with the space" } }],
      },
      save: {
        args: "(code)",
        returns: "{ ok: true, id } or { ok: false, error }",
        needs: "plugins:author",
        description: "Saves a plugin as one of the person's own for the caller's app, and turns it on, once they accept a review that shows its code and what it asks for. Its id can't be one of the app's own plugins.",
        params: [{ name: "code", schema: { type: "string", description: "The plugin's whole source: `export const manifest = { ... }` first, then `export default function (ctx) { ... }`" } }],
      },
      remove: {
        args: "(id)",
        returns: "{ ok: true } or { ok: false, error }",
        needs: "plugins:author",
        description: "Removes one of the person's own plugins for the caller's app, once they accept a review.",
        params: [{ name: "id", schema: { type: "string", description: "The id of one of the person's own plugins" } }],
      },
      file: {
        args: "(path)",
        returns: "the file's text",
        needs: "plugins:author",
        description: "A .js file in the caller's own folder or below it, such as the starting templates beside std/plugin-editor.js.",
      },
      check: {
        args: "(code)",
        returns: "{ ok: true, manifest: { id, name, description, scope }, permissions: [{ name, about }] } or { ok: false, error }",
        needs: "plugins:read",
        description: "Reads a draft's manifest the way the kernel will, without running it, and says what each permission would let it do.",
        params: [{ name: "code", schema: { type: "string", description: "The draft plugin's whole source" } }],
      },
    },
    // Reading code and checking a manifest only look, so a viewer such as std/view-source.js needs no more than plugins:read (plugins:author includes it).
    capability: (method) => (["source", "check", "page", "packages", "inspect"].includes(method) ? "plugins:read" : method === "turn" ? "plugins:manage" : "plugins:author"),
    call: async (instance, method, args, dispatch) => {
      /** The site's plugin registry (/packages/index.json), or none. */
      const registry = async (): Promise<Package[]> => {
        try {
          const response = await fetch(new URL("/packages/index.json", saving.origin));
          if (response.ok) return ((await response.json()) as { packages?: Package[] }).packages ?? [];
        } catch {
          // No registry on this site.
        }
        return [];
      };
      const tab = tabOf(instance);
      if (method === "source") {
        const [id] = args;
        const app = saving.appIn(tab);
        const own = app && typeof id === "string" ? (await saving.userAdded.list(app)).find((p) => p.id === id) : undefined;
        if (app && own) return { id, name: own.name ?? id, code: (await saving.store.readText(`user/${app}/${own.file}`)) ?? "" };
        if (typeof id !== "string" || !(apps.linkedBy(tab) ?? []).includes(id)) throw new Error(`${String(id)} isn't a plugin in this app`);
        const plugin = remote.installed.get(id);
        if (!plugin) throw new Error(`${id} hasn't loaded yet`);
        return { id, name: plugin.manifest.name, code: plugin.source };
      }
      if (method === "copy") {
        const [id] = args;
        if (typeof id !== "string" || !(apps.linkedBy(tab) ?? []).includes(id)) throw new Error(`${String(id)} isn't a plugin in this app`);
        const plugin = remote.installed.get(id);
        if (!plugin) throw new Error(`${id} hasn't loaded yet`);
        return copyOf(plugin.source, plugin.href);
      }
      if (method === "file") {
        const [path] = args;
        const href = remote.installed.get(instance.split("@")[0])?.href;
        if (!href) throw new Error("Only a plugin an app links has files next to it");
        if (typeof path !== "string") throw new Error("file() needs a path");
        const folder = new URL(".", href);
        const url = new URL(path, folder);
        if (url.origin !== folder.origin || !url.pathname.startsWith(folder.pathname) || !url.pathname.endsWith(".js") || url.search || url.hash) {
          throw new Error(`${path} isn't a .js file in the plugin's own folder`);
        }
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${path}: ${response.status}`);
        const text = await response.text();
        if (text.length > MAX) throw new Error(`${path} is longer than ${MAX} characters`);
        return text;
      }
      if (method === "check") {
        const [code] = args;
        if (typeof code !== "string") throw new Error("check() needs the code as a string");
        if (code.length > MAX) return { ok: false, error: `A plugin is limited to ${MAX} characters` };
        try {
          const m = readManifest(code);
          const taken = takenCollection(m);
          if (taken) return { ok: false, error: taken };
          return {
            ok: true,
            manifest: { id: m.id, name: m.name, description: m.description ?? "", scope: m.scope ?? "shared" },
            permissions: m.permissions.map((name) => ({ name, about: explain(name) })),
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (method === "mine") {
        const app = saving.appIn(tab);
        if (!app) return [];
        const list = await saving.userAdded.list(app);
        const marked: (UserPlugin & { shared?: boolean })[] = (await saving.shared()?.mark(app, list)) ?? list;
        // A service one needs that nothing here has, nor any of their plugins here provides: say where to get it.
        const running = new Set(saving.services());
        const lacking = (p: UserPlugin) => (p.services ?? []).filter((s) => !running.has(s) && !list.some((o) => o.provides?.includes(s)));
        const packages = list.some((p) => lacking(p).length) ? await registry() : [];
        const needs = (p: UserPlugin) =>
          lacking(p)
            .map((s) => {
              const from = packages.find((pkg) => pkg.provides.includes(s));
              return `Needs the ${s} service, which nothing here provides${from ? `: add ${from.name} from this site's registry` : ""}.`;
            })
            .join(" ");
        return marked.map((p) => ({
          id: p.id ?? p.file,
          name: p.name ?? p.file,
          description: p.description ?? "",
          permissions: p.permissions ?? [],
          places: Object.values(p.places ?? {}).map((at) => `${at.put}${at.each ? " each" : ""} ${at.at}`),
          on: p.on,
          shared: !!p.shared,
          ...(p.error ? { error: p.error } : needs(p) ? { error: needs(p) } : {}),
        }));
      }
      if (method === "page") {
        return { space: !!saving.shared(), ...((await saving.page(tab, "state", [], dispatch)) as object) };
      }
      if (method === "inspect") return saving.page(tab, "inspect", [], dispatch);
      if (method === "packages") {
        const app = saving.appIn(tab);
        const packages = await registry();
        const have = new Set(app ? (await saving.userAdded.list(app)).map((p) => p.id) : []);
        const running = new Set(saving.services());
        const providerOf = (service: string) => (running.has(service) ? undefined : packages.find((p) => p.provides.includes(service)));
        /** The package and, first, every package that provides a service it needs and isn't here yet. */
        const withNeeds = (pkg: Package, seen = new Set<string>()): Package[] => {
          if (seen.has(pkg.id)) return [];
          seen.add(pkg.id);
          const needs = pkg.services.map(providerOf).filter((p): p is Package => !!p && !have.has(p.id));
          return [...needs.flatMap((p) => withNeeds(p, seen)), pkg];
        };
        return packages.map((pkg) => ({
          id: pkg.id,
          name: pkg.name,
          description: pkg.description,
          href: pkg.href,
          permissions: pkg.permissions,
          added: have.has(pkg.id),
          // A standard plugin the app links already runs here: adding a copy of it would clash.
          linked: (apps.linkedBy(tab) ?? []).includes(pkg.id),
          adds: withNeeds(pkg).filter((p) => !have.has(p.id)).map((p) => ({ id: p.id, name: p.name, href: p.href })),
        }));
      }
      if (method === "unlock" || method === "lock") {
        const [plugin, place] = args;
        const app = appOf(tab);
        const at = typeof plugin === "string" && typeof place === "string" ? remote.installed.get(plugin)?.manifest.places?.[place] : undefined;
        if (!at || !(apps.linkedBy(tab) ?? []).concat([...(await saving.userAdded.ids(app))]).includes(plugin as string)) return { ok: false, error: `${String(plugin)} has no place ${String(place)} in this app` };
        if (method === "unlock") {
          const caller = instance.split("@")[0];
          const name = remote.installed.get(plugin as string)?.manifest.name ?? plugin;
          const yes = allowed(
            await saving.ask(
              { plugin: caller, instance, name: remote.installed.get(caller)?.manifest.name ?? caller, place: `author:${app}`, target: `the page: lets ${name} ${at.put} ${at.at}`, before: "", after: "", reason: "The app's author locked this part of the page, so plugins can't change it.", once: true },
              dispatch,
            ),
          );
          if (!yes) return { ok: false, error: "Still locked" };
        }
        await saving.unlock(app, plugin as string, place as string, method === "unlock");
        return { ok: true };
      }
      if (method === "turn") {
        const [id, on] = args;
        const app = appOf(tab);
        if (typeof on !== "boolean") return { ok: false, error: "turn(id, on) takes true or false" };
        if (typeof id !== "string" || !(await saving.userAdded.list(app)).some((p) => p.id === id)) return { ok: false, error: `${String(id)} isn't one of your plugins here` };
        // Turning one on turns on the person's plugins that provide the services it needs; turning a provider
        // off turns off the ones that need it. Neither waits on kernel.json: that is the site's, not theirs.
        const has = new Set(saving.services());
        const also = on ? await saving.userAdded.onWithNeeds(app, id, (service) => has.has(service)) : await saving.userAdded.offWithDependents(app, id, (service, not) => has.has(service) && remote.providers.get(service) !== not);
        await saving.reopen(app);
        return { ok: true, also: also.map((p) => ({ id: p.id, name: p.name ?? p.id })) };
      }
      if (["save", "remove", "add", "pick", "share", "unshare"].includes(method)) {
        const app = appOf(tab);
        const caller = instance.split("@")[0];
        const mine = await saving.userAdded.list(app);
        const ask = async (target: string, before: string, after: string, reason: string) =>
          allowed(await saving.ask({ plugin: caller, instance, name: remote.installed.get(caller)?.manifest.name ?? caller, place: `author:${app}`, target, before, after, reason, once: true }, dispatch));
        /** The code of one of the person's plugins as it is now, or undefined if there is none with that id. */
        const current = async (id: string) => {
          const file = (await saving.userAdded.list(app)).find((p) => p.id === id)?.file;
          return file ? ((await saving.store.readText(`user/${app}/${file}`)) ?? "") : undefined;
        };
        const changed = "It changed while the review was open (in another tab, perhaps), so nothing was done. Look again and try once more.";
        /** What a checker on plugins:beforeAdd said: an error to give back if it stopped the plugin, or undefined. */
        const checked = async (m: { id: string; name: string; permissions: string[] }, code: string, how: string) => {
          const verdict = await saving.check?.({ app, id: m.id, name: m.name, permissions: m.permissions, code, how, by: caller }, dispatch);
          if (verdict && typeof verdict === "object" && "block" in verdict) return { ok: false as const, error: `Stopped before review: ${String((verdict as { block: unknown }).block)}`, blocked: true };
          return undefined;
        };
        const once = async <T>(id: string, work: () => Promise<T>): Promise<T | { ok: false; error: string }> => {
          const key = `${app}/${id}`;
          if (asking.has(key)) return { ok: false, error: "There's already a review open for this plugin. Answer that one first." };
          asking.add(key);
          try {
            return await work();
          } finally {
            asking.delete(key);
          }
        };

        if (method === "add") {
          const [url] = args;
          if (typeof url !== "string") return { ok: false, error: "add(url) takes the plugin's .js file on this site" };
          const fetched = await saving.userAdded.fetch(url);
          if (!fetched.ok) return fetched;
          const wrongAdd = await saving.userAdded.problem(app, fetched.files);
          if (wrongAdd) return { ok: false, error: wrongAdd };
          let m;
          try {
            m = readManifest(fetched.source);
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          const taken = takenCollection(m);
          if (taken) return { ok: false, error: taken };
          if (!mine.some((p) => p.id === m.id) && remote.installed.has(m.id)) return { ok: false, error: `${m.id} is already a plugin on this page` };
          const manifest = m;
          return once(manifest.id, async () => {
            const stopped = await checked(manifest, fetched.source, "add");
            if (stopped) return stopped;
            const before = await current(manifest.id);
            if (!(await ask(`your plugins: ${before === undefined ? "adds" : "changes"} ${manifest.name}`, before ?? "", fetched.source, `It is added off. Once it is on, it can: ${words(manifest.permissions)}`))) return { ok: false, error: "Not added" };
            if ((await current(manifest.id)) !== before) return { ok: false, error: changed };
            // The files the person saw, not the site's files read again.
            const added = await saving.userAdded.add(app, fetched.files);
            if (!added.ok) return added;
            // Adding a plugin again turns it off: stop the copy that was running.
            await saving.reopen(app);
            return { ok: true, id: manifest.id };
          });
        }

        if (method === "pick") {
          const files = (await saving.page(tab, "pick", [], dispatch)) as { name: string; data: string | Blob }[] | null;
          if (!files?.length) return { ok: false, error: "No file chosen" };
          const main = files.filter((f) => f.name.endsWith(".js") && typeof f.data === "string");
          if (main.length !== 1) return { ok: false, error: "Pick one plugin's .js file, and any files it lists" };
          const wrongPick = await saving.userAdded.problem(app, files);
          if (wrongPick) return { ok: false, error: wrongPick };
          const source = main[0].data as string;
          let m;
          try {
            m = readManifest(source);
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          const taken = takenCollection(m);
          if (taken) return { ok: false, error: taken };
          if (!mine.some((p) => p.id === m.id) && remote.installed.has(m.id)) return { ok: false, error: `${m.id} is already a plugin on this page` };
          const manifest = m;
          return once(manifest.id, async () => {
            const stopped = await checked(manifest, source, "pick");
            if (stopped) return stopped;
            const before = await current(manifest.id);
            if (!(await ask(`your plugins: ${before === undefined ? "adds" : "changes"} ${manifest.name}`, before ?? "", source, `It is added off. Once it is on, it can: ${words(manifest.permissions)}`))) return { ok: false, error: "Not added" };
            if ((await current(manifest.id)) !== before) return { ok: false, error: changed };
            const added = await saving.userAdded.add(app, files);
            if (!added.ok) return added;
            await saving.reopen(app);
            return { ok: true, ids: added.ids };
          });
        }

        if (method === "share" || method === "unshare") {
          const [id] = args;
          const sharing = saving.shared();
          if (!sharing) return { ok: false, error: "Only a plugin in a space can be shared with it" };
          const own = mine.find((p) => p.id === id);
          if (!own || typeof id !== "string") return { ok: false, error: `${String(id)} isn't one of your plugins here` };
          return once(id, async () => {
            const code = (await current(id)) ?? "";
            const toShare = method === "share";
            const target = `the space: ${toShare ? "shares" : "stops sharing"} ${own.name ?? id}`;
            const reason = toShare ? "Everyone in this space gets it on their devices, turned off, and each decides whether to turn it on." : "It goes from everyone else's devices, and stays here as yours.";
            if (!(await ask(target, toShare ? "" : code, toShare ? code : "", reason))) return { ok: false, error: toShare ? "Not shared" : "Still shared" };
            if ((await current(id)) !== code) return { ok: false, error: changed };
            const done = await (toShare ? sharing.share(app, id) : sharing.unshare(app, id));
            return done ? { ok: true } : { ok: false, error: toShare ? `${id} couldn't be shared` : `${id} isn't shared with the space` };
          });
        }

        if (method === "remove") {
          const [id] = args;
          const own = mine.find((p) => p.id === id);
          if (!own || typeof id !== "string") return { ok: false, error: `${String(id)} isn't one of your plugins here` };
          return once(id, async () => {
            const code = (await current(id)) ?? "";
            if (!(await ask(`your plugins: removes ${own.name ?? id}`, code, "", "It stops, and its file is deleted. Your data is kept."))) return { ok: false, error: "Not removed" };
            // Remove only what the person saw.
            if ((await current(id)) !== code) return { ok: false, error: changed };
            await saving.userAdded.remove(app, id);
            await saving.reopen(app);
            return { ok: true };
          });
        }

        const [code] = args;
        if (typeof code !== "string" || code.length > MAX) return { ok: false, error: `A plugin is code, at most ${MAX} characters` };
        let m;
        try {
          m = readManifest(code);
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        const taken = takenCollection(m);
        if (taken) return { ok: false, error: taken };
        const own = mine.find((p) => p.id === m.id);
        // Changing one of the app's own plugins in place comes later; until then a copy needs an id of its own.
        if (!own && remote.installed.has(m.id)) return { ok: false, error: `${m.id} is already a plugin on this page. Give yours a new id.` };
        const manifest = m;
        return once(manifest.id, async () => {
          const stopped = await checked(manifest, code, "save");
          if (stopped) return stopped;
          const before = await current(manifest.id);
          if (!(await ask(`your plugins: ${before === undefined ? "adds" : "changes"} ${manifest.name}`, before ?? "", code, `Once it is on, it can: ${words(manifest.permissions)}`))) return { ok: false, error: "Not saved" };
          // Replace only the version the person saw, or add one that still isn't there.
          if ((await current(manifest.id)) !== before) return { ok: false, error: changed };
          const added = await saving.userAdded.add(app, [{ name: `${manifest.id}.js`, data: code }]);
          if (!added.ok) return added;
          await saving.userAdded.on(app, manifest.id);
          // A running copy with other code is stopped, so opening the app again starts the new code under the same id.
          const running = remote.installed.get(manifest.id);
          if (running && running.source !== code) remote.uninstall(manifest.id);
          await saving.turnOn([manifest.id]);
          await saving.reopen(app);
          return { ok: true, id: manifest.id };
        });
      }
      throw new Error(`authoring.${method} is not a method`);
    },
  };
}
