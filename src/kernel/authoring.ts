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

import { isAgentFile } from "../shared/agent-runner";
import { COMPONENT_NAMES } from "../shared/html-allowed";
import { readManifest } from "./manifest";
import type { Dispatch } from "../shared/protocol";
import type { RemotePlugins, ServiceProvider } from "./remote";
import { allowed, type Outcome, type Request } from "./review";
import type { Store } from "./store";
import { SIGNED_IN } from "./modules";
import { EVERYWHERE, folderOf, type UserPlugin, type UserPlugins } from "./user-plugins";
import { asMove, movable, type Moved } from "./moves";

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
  /** Moves one of a plugin's places to where the person put it, or back with null (moves.ts), and opens the app again. */
  move(app: string, plugin: string, place: string, to: Moved | null): Promise<void>;
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
  // A copy is one file: `code` was given whole (remote.whole), so the copy's manifest doesn't name the other file.
  if (original.code) manifest = manifest.replace(new RegExp(`${field("code").source}\\s*,?`), "");
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
  if (kind === "network" && verb) return `Connect to ${[verb, what].filter(Boolean).join(":")}.`;
  if (kind === "secret" && verb) return `Use a key you give it for ${verb}, which it never sees: the site adds it to its requests.`;
  if (permission === "ui:theme") return "Change the app's colours and shapes.";
  if (kind === "ui" && verb === "transform" && what) return `Change how ${what}'s view looks.`;
  if (kind === "bus" && verb === "send") return `Send messages to ${what === "*" ? "any agent" : what}.`;
  if (kind === "agents" && verb === "run" && what) return `Start the ${what} agent.`;
  if (permission === "llm") return "Ask a language model, with the key you gave it.";
  if (permission === "agent") return "Work as an agent: when something wakes it, it asks a model what to do and uses the tools it is allowed.";
  if (permission === "bus:inbox") return "Get the messages written to it.";
  if (permission === "bus:ask") return "Ask you a question, on the board.";
  if (permission === "commands") return "Run this app's commands, as its buttons and shortcuts do.";
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
  if (permission === "device-model") return "Ask the language model that is part of your browser. What you ask stays on this device.";
  if (permission === "space-model") return "Ask a language model on the key this space's owner gave it. You are shown whose key pays first.";
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
  /** A permission in words for a list (Customize's), where one that is a service's name says so. */
  const say = (permission: string, known: Iterable<string> = saving.services()) => ([...known].includes(permission) ? `Use the ${permission} service.` : explain(permission));
  /** What a sample is and asks for, read from its file, so the person sees what a sample's button adds before pressing it. */
  const sampled = new Map<string, Promise<{ href: string; title: string }>>();
  /** Read once for as long as the kernel runs: the panel asks on every draw. */
  const sample = (s: { href: string; title: string }) => {
    let reading = sampled.get(s.href);
    if (!reading) sampled.set(s.href, (reading = readSample(s)));
    return reading.then((read) => ({ ...read, title: s.title }));
  };
  const readSample = async (s: { href: string; title: string }) => {
    try {
      const response = await fetch(new URL(s.href, saving.origin));
      if (!response.ok) throw new Error(`${response.status}`);
      const m = readManifest(await response.text());
      return { ...s, id: m.id, name: m.name, description: m.description ?? "", can: m.permissions.map((permission) => say(permission)), places: Object.values(m.places ?? {}).map((at) => `${at.put}${at.each ? " each" : ""} ${at.at}`) };
    } catch {
      // Its button still adds it, and the review says what is wrong with it.
      return s;
    }
  };

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
        returns: "[{ id, name, description, permissions, places, on, shared, everywhere, agent, error? }]",
        needs: "plugins:author",
        description: "The person's own plugins for the caller's app. In a space, shared says which are the space's plugins. everywhere says which ones they use in every app (kept once, and on or off in all of them). error says why one can't run: its manifest can't be read, or it needs a service nothing here provides (and which registry package does).",
        params: [],
      },
      add: {
        args: "(url, { everywhere }?)",
        returns: "{ ok: true, id } or { ok: false, error }",
        needs: "plugins:author",
        description: "Adds a plugin from this site, such as one in the registry at /packages/, to the person's own for the caller's app, with the files its manifest lists, once they accept a review that shows its code and what it asks for. It is added off: turn it on with turn(). With { everywhere: true } it is added for every app the person opens on this device, and the review says so.",
        params: [
          { name: "url", schema: { type: "string", description: "The plugin's .js file on this site: /packages/clock/clock.js" } },
          { name: "options", schema: { type: "object", description: "{ everywhere: true } to add it for every app, not only this one" } },
        ],
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
        returns: "{ space, places: [{ plugin, name, at, put, each, state, matches, fragile }], running: [{ id, name, user, unlocked }], samples: [{ href, title, id?, name?, description?, can?, places? }], inspect }",
        needs: "plugins:read",
        description: "The caller's page as Customize shows it: whether it is in a space, how each plugin's places went (drawn, waiting, declined, locked, no match, or slot when the page has its own slot of that name), which plugins run and which locked places each was let into, the samples the app offers (link rel=plugin-sample) with what each is and can do once on (read from its manifest), and whether it has inspect mode.",
        params: [],
      },
      packages: {
        args: "()",
        returns: "[{ id, name, description, href, permissions, can, added, linked, adds: [{ id, name, href }] }]",
        needs: "plugins:read",
        description: "The site's plugin registry (/packages/): each package, what its permissions let it do in words (can), whether the person has added it to this app, whether the app links it already (linked), and what adding it adds, in order: first the packages that provide services it needs that aren't here yet, then itself.",
        params: [],
      },
      pick: {
        args: "()",
        returns: "{ ok: true, ids } or { ok: false, error }",
        needs: "plugins:author",
        description: "Opens the file chooser, right after the person clicks, and adds the plugin they pick (with any files it lists), or the agent (.agent.md), to their own for the caller's app, once they accept a review of its code. It is added off.",
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
      move: {
        args: "(plugin, place, to)",
        returns: "{ ok: true } or { ok: false, error }",
        needs: "plugins:manage",
        description: "Moves one of a plugin's places in the caller's app to another spot on the page, for this person: to is { at, put, order? } with put before, after, prepend or append, or null to put it back where the plugin said. A place that hides, replaces, draws in every match or changes another plugin's view can't be moved. The author's locks still hold at the new spot.",
        params: [
          { name: "plugin", schema: { type: "string", description: "The plugin's id" } },
          { name: "place", schema: { type: "string", description: "The name of one of its places" } },
          { name: "to", schema: { type: "object", description: "{ at: CSS selector, put: before|after|prepend|append, order?: number }, or null" } },
        ],
      },
      arrange: {
        args: "(plugin?, place?)",
        returns: "true",
        needs: "plugins:read",
        description: "Starts the page's arrange mode, where the person sees every plugin's view that can move and drags or points it somewhere else; with a plugin (and place), that one is picked to move.",
      },
      layout: {
        args: "()",
        returns: "{ slots: [{ name, plugins }], parts: [{ selector, name, mark }], elements: [{ tag, attributes, about }] }",
        needs: "plugins:read",
        description: "Where plugins can go on the caller's page: the page's slots and which plugins draw in each, the parts its author named (ids, data-part, landmarks) with the mark that governs adding there (open, review or locked), and the ui-* elements a view can use.",
        params: [],
      },
      choose: {
        args: "(prompt?)",
        returns: "{ at, put, label } or null",
        needs: "plugins:author",
        description: "Asks the person to point at a spot on the page, and says where: a selector and before, after, prepend or append, ready for a place in a new plugin's manifest. null if they cancel.",
        params: [{ name: "prompt", optional: true, schema: { type: "string", description: "Short prompt shown while the person points at a spot on the page" } }],
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
      everywhere: {
        args: "(id, on)",
        returns: "{ ok: true } or { ok: false, error }",
        needs: "plugins:author",
        description: "Keeps one of the person's own plugins for every app they open on this device (on true), once they accept a review that says what it can do in each, or brings one back to the caller's app alone (on false). A plugin of the same id that an app links, or that the person keeps for that app, runs there instead.",
        params: [
          { name: "id", schema: { type: "string", description: "The id of one of the person's own plugins" } },
          { name: "on", schema: { type: "boolean", description: "true for every app, false for this app only" } },
        ],
      },
      save: {
        args: "(code, files?)",
        returns: "{ ok: true, id } or { ok: false, error }",
        needs: "plugins:author",
        description: "Saves a plugin (and any companion template/style files listed in its manifest's `files`) as one of the person's own for the caller's app, and turns it on, once they accept a review that shows its code and what it asks for. Code that opens with `---` frontmatter is saved as an agent of theirs (.agent.md).",
        params: [
          { name: "code", schema: { type: "string", description: "The plugin's whole source: `export const manifest = { ... }` first, then `export default function (ctx) { ... }`" } },
          { name: "files", optional: true, schema: { type: "object", description: "Optional companion files listed in manifest.files, e.g. { \"view.html\": \"<template id=...>\" }" } },
        ],
      },
      components: {
        args: "()",
        returns: "[{ tag, attributes, about, html, everywhere }]",
        needs: "plugins:read",
        description: "The person's own reusable `ui-*` custom components for the caller's app.",
        params: [],
      },
      saveComponent: {
        args: "(tag, html, { everywhere }?)",
        returns: "{ ok: true, tag } or { ok: false, error }",
        needs: "plugins:author",
        description: "Saves a reusable `ui-*` template component (`<template>` with optional `<style>`, `{{attribute}}` holes and `<slot>`, and no `<script>`) for the caller's app (or every app when `everywhere: true`), once the person accepts a review. Plugins in the app can then use `<ui-...>` in their HTML views and templates.",
        params: [
          { name: "tag", schema: { type: "string", description: "Custom element tag starting with `ui-`, e.g. `ui-rating-card` (not one of the platform's built-in `ui-*` names)" } },
          { name: "html", schema: { type: "string", description: "Component HTML containing `<template>` (with optional `<style>`, `{{attr}}` holes, `<slot>`, and `<meta name=\"description\" content=\"...\">`)" } },
          { name: "options", optional: true, schema: { type: "object", description: "{ everywhere: true } to make the component available in every app" } },
        ],
      },
      removeComponent: {
        args: "(tag)",
        returns: "{ ok: true } or { ok: false, error }",
        needs: "plugins:author",
        description: "Removes one of the person's custom `ui-*` components for the caller's app, once they accept a review.",
        params: [{ name: "tag", schema: { type: "string", description: "The custom `ui-*` tag to remove" } }],
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
    capability: (method) => (["source", "check", "page", "packages", "inspect", "arrange", "layout", "components"].includes(method) ? "plugins:read" : method === "turn" || method === "move" ? "plugins:manage" : "plugins:author"),
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
        if (app && own) return { id, name: own.name ?? id, code: (await saving.userAdded.read(app, id as string)) ?? "" };
        if (typeof id !== "string" || !(apps.linkedBy(tab) ?? []).includes(id)) throw new Error(`${String(id)} isn't a plugin in this app`);
        const plugin = remote.installed.get(id);
        if (!plugin) throw new Error(`${id} hasn't loaded yet`);
        return { id, name: plugin.manifest.name, code: await remote.whole(plugin) };
      }
      if (method === "copy") {
        const [id] = args;
        if (typeof id !== "string" || !(apps.linkedBy(tab) ?? []).includes(id)) throw new Error(`${String(id)} isn't a plugin in this app`);
        const plugin = remote.installed.get(id);
        if (!plugin) throw new Error(`${id} hasn't loaded yet`);
        return copyOf(await remote.whole(plugin), plugin.href);
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
          everywhere: !!p.everywhere,
          agent: isAgentFile(p.file),
          ...(p.error ? { error: p.error } : needs(p) ? { error: needs(p) } : {}),
        }));
      }
      if (method === "page") {
        const state = (await saving.page(tab, "state", [], dispatch)) as { samples?: { href: string; title: string }[] };
        // Only this site's files are read: a sample linked from elsewhere keeps its title alone.
        // The first 40 are read for what they are and ask for; any past that keep their title.
        const samples = await Promise.all((state.samples ?? []).map((s, i) => (i < 40 && new URL(s.href, saving.origin).origin === saving.origin ? sample(s) : s)));
        // Whether someone is signed in on this device (the account app's mark, or a space), so Customize asks the `follow` module only then.
        const account = !!saving.shared() || (await saving.store.readText(SIGNED_IN)) !== undefined;
        return { space: !!saving.shared(), account, ...state, samples };
      }
      const describeComponent = (c: { tag: string; html: string; everywhere?: boolean }) => {
        const holes = [...new Set([...c.html.matchAll(/\{\{\s*([a-z][\w-]*)\s*\}\}/gi)].map((m) => m[1].toLowerCase()))];
        const about = /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i.exec(c.html)?.[1] ?? "Custom component made for this app.";
        return { tag: c.tag, attributes: holes.join(", "), about, html: c.html, everywhere: !!c.everywhere };
      };
      if (method === "components") {
        const app = saving.appIn(tab);
        return app ? (await saving.userAdded.components(app)).map(describeComponent) : [];
      }
      if (method === "inspect") return saving.page(tab, "inspect", [], dispatch);
      if (method === "layout") {
        const base = (await saving.page(tab, "layout", [], dispatch)) as { slots: unknown[]; parts: unknown[]; elements: { tag: string; attributes: string; about: string; custom?: boolean }[] };
        const app = saving.appIn(tab);
        const custom = app ? (await saving.userAdded.components(app)).map((c) => {
          const d = describeComponent(c);
          return { tag: d.tag, attributes: d.attributes, about: d.about, custom: true };
        }) : [];
        return { ...base, elements: [...(base.elements ?? []), ...custom] };
      }
      if (method === "arrange") return saving.page(tab, "arrange", args.slice(0, 2).map((a) => (typeof a === "string" ? a : undefined)), dispatch);
      if (method === "choose") return saving.page(tab, "choose", [typeof args[0] === "string" ? args[0].slice(0, 120) : undefined], dispatch);
      if (method === "move") {
        const [plugin, place, to] = args;
        const app = appOf(tab);
        const at = typeof plugin === "string" && typeof place === "string" ? remote.installed.get(plugin)?.manifest.places?.[place] : undefined;
        if (!at || !(apps.linkedBy(tab) ?? []).concat([...(await saving.userAdded.ids(app))]).includes(plugin as string)) return { ok: false, error: `${String(plugin)} has no place ${String(place)} in this app` };
        if (!movable(at)) return { ok: false, error: `${String(place)} hides, replaces or changes a part of the page, or draws in every match, so only its plugin can say where it goes` };
        const move = to === null ? null : asMove(to);
        if (move === undefined) return { ok: false, error: "to is { at, put } with put before, after, prepend or append, or null" };
        await saving.move(app, plugin as string, place as string, move);
        return { ok: true };
      }
      if (method === "packages") {
        const app = saving.appIn(tab);
        const packages = await registry();
        const have = new Set(app ? (await saving.userAdded.list(app)).map((p) => p.id) : []);
        const running = new Set(saving.services());
        const providerOf = (service: string) => (running.has(service) ? undefined : packages.find((p) => p.provides.includes(service)));
        /** The services a permission may name: the ones running here, and the ones a registry package provides. */
        const known = new Set([...running, ...packages.flatMap((p) => p.provides)]);
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
          can: pkg.permissions.map((permission) => say(permission, known)),
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
        const also = on ? await saving.userAdded.onWithNeeds(app, id, (service) => has.has(service), (service, not) => has.has(service) && remote.providers.get(service) !== not) : await saving.userAdded.offWithDependents(app, id, (service, not) => has.has(service) && remote.providers.get(service) !== not);
        // One the person uses in every app is on or off in every app.
        const all = await saving.userAdded.list(app);
        await saving.reopen([id, ...also.map((p) => p.id)].some((changed) => all.find((p) => p.id === changed)?.everywhere) ? EVERYWHERE : app);
        return { ok: true, also: also.map((p) => ({ id: p.id, name: p.name ?? p.id })) };
      }
      if (["save", "remove", "add", "pick", "share", "unshare", "everywhere", "saveComponent", "removeComponent"].includes(method)) {
        const app = appOf(tab);
        const caller = instance.split("@")[0];
        const mine = await saving.userAdded.list(app);
        const ask = async (target: string, before: string, after: string, reason: string) =>
          allowed(await saving.ask({ plugin: caller, instance, name: remote.installed.get(caller)?.manifest.name ?? caller, place: `author:${app}`, target, before, after, reason, once: true }, dispatch));
        /** The code of one of the person's plugins as it is now, or undefined if there is none with that id. */
        const current = (id: string) => saving.userAdded.read(app, id);
        /** Where one of the person's plugins is kept: this app's folder, or the one for every app. */
        const keptIn = (id: string) => folderOf(app, mine.find((p) => p.id === id) ?? {});
        /** A plugin shared with the space stays the kind it is: the space sends its code to the other members as a plugin's. */
        const sharedAsOther = async (id: string, file: string) => {
          const own = mine.find((p) => p.id === id);
          return own && isAgentFile(own.file) !== isAgentFile(file) && (await saving.shared()?.mark(app, [own]))?.[0]?.shared ? `${own.name ?? id} is shared with the space. Stop sharing it first` : undefined;
        };
        const changed = "It changed while the review was open (in another tab, perhaps), so nothing was done. Look again and try once more.";
        const linkedHere = apps.linkedBy(tab) ?? [];
        /** The app's own plugin that one of the person's with this id would replace in this app, if any. */
        const replaces = (id: string) => (!mine.some((p) => p.id === id) && linkedHere.includes(id) ? remote.installed.get(id) : undefined);
        /** Why the person can't add a plugin with this id here: another plugin on the page has it, and this app doesn't link it. */
        const clash = (id: string, more = "") => (!mine.some((p) => p.id === id) && remote.installed.has(id) && !linkedHere.includes(id) ? `${id} is already a plugin on this page${more}` : undefined);
        /** What the review says it does, and the code it shows as before: the app's own plugin's, when it replaces that. */
        const asked = (m: { id: string; name: string }, before: string | undefined) => {
          const app = replaces(m.id);
          if (before === undefined && app) return { target: `your plugins: replaces ${app.manifest.name} with ${m.name}`, before: app.source };
          return { target: `your plugins: ${before === undefined ? "adds" : "changes"} ${m.name}`, before: before ?? "" };
        };
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
          const [url, options] = args;
          if (typeof url !== "string") return { ok: false, error: "add(url) takes a plugin's .js file, or an agent's .agent.md file, on this site" };
          // For every app the person opens here, rather than this one: a language model they bring their own key to, say.
          const everywhere = !!options && typeof options === "object" && (options as { everywhere?: unknown }).everywhere === true;
          const folder = everywhere ? EVERYWHERE : app;
          const fetched = await saving.userAdded.fetch(url);
          if (!fetched.ok) return fetched;
          const wrongAdd = await saving.userAdded.problem(folder, fetched.files);
          if (wrongAdd) return { ok: false, error: wrongAdd };
          let m;
          try {
            m = await saving.userAdded.manifest(fetched.files[0].name, fetched.source);
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          const taken = takenCollection(m);
          if (taken) return { ok: false, error: taken };
          const clashAdd = clash(m.id);
          if (clashAdd) return { ok: false, error: clashAdd };
          const sharedAdd = await sharedAsOther(m.id, fetched.files[0].name);
          if (sharedAdd) return { ok: false, error: sharedAdd };
          const manifest = m;
          return once(manifest.id, async () => {
            const stopped = await checked(manifest, fetched.source, "add");
            if (stopped) return stopped;
            const before = await current(manifest.id);
            const review = asked(manifest, before);
            const reach = everywhere ? " It is added for every app you open on this device, not only this one." : "";
            if (!(await ask(`${review.target}${everywhere ? ", for every app" : ""}`, review.before, fetched.source, `Once it is on, it can: ${words(manifest.permissions)}${reach}`))) return { ok: false, error: "Not added" };
            if ((await current(manifest.id)) !== before) return { ok: false, error: changed };
            // The files the person saw, not the site's files read again.
            const added = await saving.userAdded.add(folder, fetched.files);
            if (!added.ok) return added;
            // Adding a plugin again turns it off: stop the copy that was running.
            await saving.reopen(folder);
            return { ok: true, id: manifest.id };
          });
        }

        if (method === "pick") {
          const files = (await saving.page(tab, "pick", [], dispatch)) as { name: string; data: string | Blob }[] | null;
          if (!files?.length) return { ok: false, error: "No file chosen" };
          const main = files.filter((f) => (f.name.endsWith(".js") || isAgentFile(f.name)) && typeof f.data === "string");
          if (main.length !== 1) return { ok: false, error: "Pick one plugin's .js file and any files it lists, or one agent's .agent.md file" };
          const wrongPick = await saving.userAdded.problem(app, files);
          if (wrongPick) return { ok: false, error: wrongPick };
          const source = main[0].data as string;
          let m;
          try {
            m = await saving.userAdded.manifest(main[0].name, source);
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          const taken = takenCollection(m);
          if (taken) return { ok: false, error: taken };
          const clashPick = clash(m.id);
          if (clashPick) return { ok: false, error: clashPick };
          const sharedPick = await sharedAsOther(m.id, main[0].name);
          if (sharedPick) return { ok: false, error: sharedPick };
          const manifest = m;
          return once(manifest.id, async () => {
            const stopped = await checked(manifest, source, "pick");
            if (stopped) return stopped;
            const before = await current(manifest.id);
            const review = asked(manifest, before);
            if (!(await ask(review.target, review.before, source, `Once it is on, it can: ${words(manifest.permissions)}`))) return { ok: false, error: "Not added" };
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
            const what = isAgentFile(own.file) ? "agent" : "plugin";
            const reason = toShare
              ? `Everyone in this space gets this ${what} on their devices, turned off, and each decides whether to turn it on.${isAgentFile(own.file) ? " It asks each person's own model, with their own key." : ""}${own.everywhere ? " A copy for this app is what the space gets: yours stays in every app you open." : ""}`
              : "It goes from everyone else's devices, and stays here as yours.";
            if (!(await ask(target, toShare ? "" : code, toShare ? code : "", reason))) return { ok: false, error: toShare ? "Not shared" : "Still shared" };
            if ((await current(id)) !== code) return { ok: false, error: changed };
            const done = await (toShare ? sharing.share(app, id) : sharing.unshare(app, id)).catch((error: unknown) => {
              throw new Error(`${own.name ?? id} couldn't be shared: ${error instanceof Error ? error.message : String(error)}`);
            });
            return done ? { ok: true } : { ok: false, error: toShare ? `${id} couldn't be shared` : `${id} isn't shared with the space` };
          });
        }

        if (method === "remove") {
          const [id] = args;
          const own = mine.find((p) => p.id === id);
          if (!own || typeof id !== "string") return { ok: false, error: `${String(id)} isn't one of your plugins here` };
          return once(id, async () => {
            const code = (await current(id)) ?? "";
            if (!(await ask(`your plugins: removes ${own.name ?? id}${own.everywhere ? ", from every app" : ""}`, code, "", "It stops, and its file is deleted. Your data is kept."))) return { ok: false, error: "Not removed" };
            // Remove only what the person saw.
            if ((await current(id)) !== code) return { ok: false, error: changed };
            await saving.userAdded.remove(app, id);
            await saving.reopen(keptIn(id));
            return { ok: true };
          });
        }

        if (method === "everywhere") {
          const [id, on] = args;
          const own = mine.find((p) => p.id === id);
          if (!own || typeof id !== "string") return { ok: false, error: `${String(id)} isn't one of your plugins here` };
          if (typeof on !== "boolean") return { ok: false, error: "everywhere(id, on) takes true or false" };
          if (!!own.everywhere === on) return { ok: true };
          if (on && (await saving.shared()?.mark(app, [own]))?.[0]?.shared) return { ok: false, error: `${own.name ?? id} is shared with the space. Stop sharing it first` };
          return once(id, async () => {
            const code = (await current(id)) ?? "";
            const reason = on ? `It will run in every app you open on this device, not only this one. In each, it can: ${words(own.permissions ?? [])}` : "It stays in this app, and stops running in the others.";
            // Asked before it reaches further; bringing it back to one app only narrows what it can do.
            if (on && !(await ask(`your plugins: uses ${own.name ?? id} in every app`, "", code, reason))) return { ok: false, error: "Still for this app only" };
            if ((await current(id)) !== code) return { ok: false, error: changed };
            const moved = await saving.userAdded.everywhere(app, id, on);
            if (!moved.ok) return moved;
            await saving.reopen(EVERYWHERE);
            return { ok: true };
          });
        }

        if (method === "saveComponent") {
          const [rawTag, rawHtml, options] = args;
          const tag = typeof rawTag === "string" ? rawTag.trim().toLowerCase() : "";
          if (!/^ui-[a-z][a-z0-9-]{1,46}$/.test(tag)) return { ok: false, error: "A component tag starts with `ui-` followed by lowercase letters, digits and dashes (e.g. `ui-rating-card`)" };
          if ((COMPONENT_NAMES as readonly string[]).includes(tag)) return { ok: false, error: `<${tag}> is one of the platform's built-in components; give yours another ui-* name` };
          if (typeof rawHtml !== "string" || !rawHtml.trim() || rawHtml.length > MAX) return { ok: false, error: `A component's HTML is at most ${MAX} characters` };
          if (/<script\b/i.test(rawHtml)) return { ok: false, error: "Custom ui-* components are pure <template> markup and <style> (with {{attribute}} holes and <slot>), with no <script>" };
          if (!/<template\b[\s\S]*<\/template>/i.test(rawHtml)) return { ok: false, error: "A component file needs a <template>…</template> holding its shadow markup and optional <style>" };
          const everywhere = !!options && typeof options === "object" && (options as { everywhere?: unknown }).everywhere === true;
          const existing = (await saving.userAdded.components(app)).find((c) => c.tag === tag);
          const folder = options && typeof options === "object" && "everywhere" in options ? (everywhere ? EVERYWHERE : app) : existing?.everywhere ? EVERYWHERE : app;
          const path = `user/${folder}/elements/${tag}.html`;
          return once(`component:${tag}`, async () => {
            const stopped = await checked({ id: tag, name: `<${tag}>`, permissions: ["ui"] }, rawHtml, "component");
            if (stopped) return stopped;
            const before = await saving.store.readText(path);
            const target = `your components: ${before === undefined ? "adds" : "changes"} <${tag}>${folder === EVERYWHERE ? ", for every app" : ""}`;
            const reason = `Plugins in ${folder === EVERYWHERE ? "every app" : "this app"} can draw <${tag}> in their views. Styles stay inside its shadow root and scripts aren't allowed.`;
            if (!(await ask(target, before ?? "", rawHtml, reason))) return { ok: false, error: "Not saved" };
            if ((await saving.store.readText(path)) !== before) return { ok: false, error: changed };
            await saving.store.writeFile(path, rawHtml);
            await saving.reopen(folder);
            return { ok: true, tag };
          });
        }

        if (method === "removeComponent") {
          const [rawTag] = args;
          const tag = typeof rawTag === "string" ? rawTag.trim().toLowerCase() : "";
          const existing = (await saving.userAdded.components(app)).find((c) => c.tag === tag);
          if (!existing) return { ok: false, error: `<${String(rawTag)}> isn't one of your components here` };
          const folder = existing.everywhere ? EVERYWHERE : app;
          const path = `user/${folder}/elements/${tag}.html`;
          return once(`component:${tag}`, async () => {
            const before = (await saving.store.readText(path)) ?? "";
            if (!(await ask(`your components: removes <${tag}>${existing.everywhere ? ", from every app" : ""}`, before, "", "Plugins can no longer draw this custom component."))) return { ok: false, error: "Not removed" };
            if (((await saving.store.readText(path)) ?? "") !== before) return { ok: false, error: changed };
            await saving.store.removeFile(path);
            await saving.reopen(folder);
            return { ok: true };
          });
        }

        const [code, extraFiles] = args;
        if (typeof code !== "string" || code.length > MAX) return { ok: false, error: `A plugin is code, at most ${MAX} characters` };
        let m;
        // Code that opens with frontmatter is an agent file (agents/file.ts), kept as <id>.agent.md.
        const ext = /^\s*---\r?\n/.test(code) ? ".agent.md" : ".js";
        try {
          m = await saving.userAdded.manifest(`pasted${ext}`, ext === ".js" ? code : code.trimStart());
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        const taken = takenCollection(m);
        if (taken) return { ok: false, error: taken };
        // A copy of one of the app's own plugins, under its id, replaces it in this app; any other plugin's id is taken.
        const clashSave = clash(m.id, ". Give yours a new id.");
        if (clashSave) return { ok: false, error: clashSave };
        const sharedSave = await sharedAsOther(m.id, `pasted${ext}`);
        if (sharedSave) return { ok: false, error: sharedSave };
        const manifest = m;
        const folder = keptIn(manifest.id);
        const companions: { name: string; data: string }[] = [];
        if (extraFiles !== undefined && extraFiles !== null) {
          if (typeof extraFiles !== "object" || Array.isArray(extraFiles)) return { ok: false, error: "files must be an object mapping file names to text, e.g. { \"view.html\": \"...\" }" };
          for (const [fname, ftext] of Object.entries(extraFiles as Record<string, unknown>)) {
            if (typeof ftext !== "string" || ftext.length > MAX) return { ok: false, error: `${fname}: each companion file must be text of at most ${MAX} characters` };
            companions.push({ name: fname, data: ftext });
          }
        }
        const bundle = [{ name: `${manifest.id}${ext}`, data: ext === ".js" ? code : code.trimStart() }, ...companions];
        if (companions.length) {
          const wrongSave = await saving.userAdded.problem(folder, bundle);
          if (wrongSave) return { ok: false, error: wrongSave };
        }
        const combinedAfter = companions.length ? bundle.map((f) => `──── ${f.name} ────\n${f.data}`).join("\n\n") : code;
        return once(manifest.id, async () => {
          const stopped = await checked(manifest, combinedAfter, "save");
          if (stopped) return stopped;
          const before = await current(manifest.id);
          const beforeCombined = companions.length && before !== undefined
            ? [`──── ${manifest.id}${ext} ────\n${before}`, ...(await Promise.all(companions.map(async (f) => {
                const old = await saving.store.readText(`user/${folder}/${f.name}`);
                return old === undefined ? "" : `──── ${f.name} ────\n${old}`;
              }))).filter(Boolean)].join("\n\n")
            : before;
          const review = asked(manifest, beforeCombined);
          if (!(await ask(review.target, review.before, combinedAfter, `Once it is on, it can: ${words(manifest.permissions)}`))) return { ok: false, error: "Not saved" };
          // Replace only the version the person saw, or add one that still isn't there.
          if ((await current(manifest.id)) !== before) return { ok: false, error: changed };
          // One the person uses in every app is saved where it is kept.
          const added = await saving.userAdded.add(folder, bundle);
          if (!added.ok) return added;
          await saving.userAdded.on(app, manifest.id);
          // Opening the app again stops a running copy with other code (if only this app uses it) and starts the new code under the same id.
          await saving.turnOn([manifest.id]);
          await saving.reopen(folder);
          return { ok: true, id: manifest.id };
        });
      }
      throw new Error(`authoring.${method} is not a method`);
    },
  };
}
