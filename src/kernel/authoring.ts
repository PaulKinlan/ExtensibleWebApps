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

type Apps = { linkedBy(tab: string): string[] | undefined };

/** What saving needs from the kernel: the person's plugins, the app open in each tab, and the review. */
export interface Saving {
  store: Store;
  userAdded: UserPlugins;
  /** The folder of the app open in a tab, if it has one. */
  appIn(tab: string): string | undefined;
  ask(request: Request, dispatch: Dispatch): Promise<Outcome>;
  /** Starts the app again in every tab that has it open, so a saved plugin runs. */
  reopen(app: string): Promise<void>;
}

/** The longest file `file()` reads, and the longest draft `check()` takes. */
const MAX = 100_000;

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
  if (permission === "plugins:read") return "See which plugins this page has, and which are on.";
  if (permission === "plugins:manage") return "Turn this page's plugins on and off.";
  if (permission === "plugins:author") return "Read the code of this page's plugins, and save plugins you write. Each save is shown to you first.";
  if (permission === "debug:read") return "See everything every plugin does, as the debug console does.";
  return `Use ${permission}.`;
}

export function authoring(remote: RemotePlugins, apps: Apps, saving: Saving): ServiceProvider {
  /** The caller's tab, or an error: the editor works on the app open in one tab. */
  const tabOf = (instance: string): string => {
    const tab = instance.split("@")[1];
    if (!tab) throw new Error('The authoring service needs scope: "tab", so it knows which app it is in');
    return tab;
  };
  const appOf = (tab: string): string => {
    const app = saving.appIn(tab);
    if (!app) throw new Error("This page has no app folder, so it can't keep plugins of your own");
    return app;
  };
  const words = (permissions: string[]) => (permissions.length ? permissions.map(explain).join(" ") : "Nothing: it can't draw, read or change anything.");

  return {
    description: "Helps a plugin editor: reads the code of the plugins in the caller's app and files next to the caller, checks a draft's manifest, and saves the person's own plugins, after they review each one. The caller must be tab-scoped.",
    methods: {
      source: {
        args: "(id)",
        returns: "{ id, name, code }",
        needs: "plugins:author",
        description: "The code of a plugin the caller's app links, or of one of the person's own for it, on or off.",
      },
      mine: {
        args: "()",
        returns: "[{ id, name, on, error? }]",
        needs: "plugins:author",
        description: "The person's own plugins for the caller's app.",
      },
      save: {
        args: "(code)",
        returns: "{ ok: true, id } or { ok: false, error }",
        needs: "plugins:author",
        description: "Saves a plugin as one of the person's own for the caller's app, and turns it on, once they accept a review that shows its code and what it asks for. Its id can't be one of the app's own plugins.",
      },
      remove: {
        args: "(id)",
        returns: "{ ok: true } or { ok: false, error }",
        needs: "plugins:author",
        description: "Removes one of the person's own plugins for the caller's app, once they accept a review.",
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
        needs: "plugins:author",
        description: "Reads a draft's manifest the way the kernel will, without running it, and says what each permission would let it do.",
      },
    },
    capability: () => "plugins:author",
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
          allowed(await saving.ask({ plugin: caller, instance, name: remote.installed.get(caller)?.manifest.name ?? caller, place: `author:${app}`, target, before, after, reason }, dispatch));

        if (method === "remove") {
          const [id] = args;
          const own = mine.find((p) => p.id === id);
          if (!own || typeof id !== "string") return { ok: false, error: `${String(id)} isn't one of your plugins here` };
          const code = (await saving.store.readText(`user/${app}/${own.file}`)) ?? "";
          if (!(await ask(`your plugins: removes ${own.name ?? id}`, code, "", "It stops, and its file is deleted. Your data is kept."))) return { ok: false, error: "Not removed" };
          await saving.userAdded.remove(app, id);
          await saving.reopen(app);
          return { ok: true };
        }

        const [code] = args;
        if (typeof code !== "string" || code.length > MAX) return { ok: false, error: `A plugin is code, at most ${MAX} characters` };
        let m;
        try {
          m = readManifest(code);
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        const own = mine.find((p) => p.id === m.id);
        // Changing one of the app's own plugins in place comes later; until then a copy needs an id of its own.
        if (!own && remote.installed.has(m.id)) return { ok: false, error: `${m.id} is already a plugin on this page. Give yours a new id.` };
        const before = own ? ((await saving.store.readText(`user/${app}/${own.file}`)) ?? "") : "";
        if (!(await ask(`your plugins: ${own ? "changes" : "adds"} ${m.name}`, before, code, `Once it is on, it can: ${words(m.permissions)}`))) return { ok: false, error: "Not saved" };
        const added = await saving.userAdded.add(app, [{ name: `${m.id}.js`, data: code }]);
        if (!added.ok) return added;
        await saving.userAdded.on(app, m.id);
        await saving.reopen(app);
        return { ok: true, id: m.id };
      }
      throw new Error(`authoring.${method} is not a method`);
    },
  };
}
