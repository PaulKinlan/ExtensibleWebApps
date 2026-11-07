// The `authoring` service: what a plugin editor (std/plugin-editor.js) needs
// to help a person write a plugin before it runs. It reads the code of the
// plugins in the caller's app, reads starting files that sit next to the
// editor, and checks a draft's manifest, saying in plain words what each
// permission it asks for would let it do.
//
// Nothing here runs or saves code. Saving a person's plugin is the user
// plugins' job, and it is reviewed there.

import { readManifest } from "./manifest";
import type { RemotePlugins, ServiceProvider } from "./remote";

type Apps = { linkedBy(tab: string): string[] | undefined };

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

export function authoring(remote: RemotePlugins, apps: Apps): ServiceProvider {
  /** The caller's tab, or an error: the editor works on the app open in one tab. */
  const tabOf = (instance: string): string => {
    const tab = instance.split("@")[1];
    if (!tab) throw new Error('The authoring service needs scope: "tab", so it knows which app it is in');
    return tab;
  };

  return {
    description: "Helps a plugin editor: reads the code of the plugins in the caller's app and files next to the caller, and checks a draft's manifest. The caller must be tab-scoped.",
    methods: {
      source: {
        args: "(id)",
        returns: "{ id, name, code }",
        needs: "plugins:author",
        description: "The code of a plugin the caller's app links.",
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
    call: async (instance, method, args) => {
      const tab = tabOf(instance);
      if (method === "source") {
        const [id] = args;
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
      throw new Error(`authoring.${method} is not a method`);
    },
  };
}
