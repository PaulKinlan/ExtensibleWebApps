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

import { readManifest } from "./manifest";
import type { Dispatch } from "../shared/protocol";
import type { RemotePlugins, ServiceProvider } from "./remote";
import { allowed, type Outcome, type Request } from "./review";
import type { Store } from "./store";
import type { UserPlugins } from "./user-plugins";

type Apps = { linkedBy(tab: string): string[] | undefined; tabsWith?(id: string): string[] };

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
  if (permission === "plugins:author") return "Read the code of this page's plugins, and save plugins you write. Each save is shown to you first.";
  if (permission === "debug:read") return "See everything every plugin does, as the debug console does.";
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
    description: "Helps a plugin editor: reads the code of the plugins in the caller's app and files next to the caller, checks a draft's manifest, and saves the person's own plugins, after they review each one. The caller must be tab-scoped.",
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
        returns: "[{ id, name, on, error? }]",
        needs: "plugins:author",
        description: "The person's own plugins for the caller's app.",
        params: [],
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
    capability: (method) => (method === "source" || method === "check" ? "plugins:read" : "plugins:author"),
    call: async (instance, method, args, dispatch) => {
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
        return (await saving.userAdded.list(app)).map((p) => ({ id: p.id ?? p.file, name: p.name ?? p.file, on: p.on, ...(p.error ? { error: p.error } : {}) }));
      }
      if (method === "save" || method === "remove") {
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
