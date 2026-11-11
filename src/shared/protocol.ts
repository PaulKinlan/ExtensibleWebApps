// Messages between the three kinds of thread:
//
//   host (page)  <-- port -->  kernel (shared worker)  <-- port -->  plugin (dedicated worker)
//
// Every message is a plain object with a `t` (type). Calls that expect an
// answer carry an `id`; the answer echoes it. Messages that run code on
// behalf of a user action carry a `trace` id so one action can be followed
// across threads.

import type { SyncToDevice, SyncToSpace } from "./sync";

/** A declarative view. Plugins never touch the DOM; the host draws these. */
export type View =
  /** Plain HTML, using the elements and components in shared/html.ts. `remote` is set by the kernel, never the plugin. */
  | { type: "html"; html: string; remote?: boolean }
  /**
   * A template from an .html file next to the plugin, filled with data by the host: `src` is the file
   * (made absolute by the kernel), `id` the template's id in it. `remote` is set by the kernel, as for html.
   */
  | { type: "template"; src: string; id: string; data?: unknown; remote?: boolean }
  | { type: "stack"; children: View[]; direction?: "row" | "column" }
  | { type: "heading"; text: string }
  | { type: "text"; text: string; title?: string; tone?: "muted" | "error" | "ok" }
  | { type: "button"; label: string; action: string; primary?: boolean }
  | { type: "list"; items: { label: string; action: string; selected?: boolean }[] }
  | {
      type: "textarea";
      name: string;
      value: string;
      action: string;
      placeholder?: string;
      /** Editor events (src/host/editing.ts): the action the settled selection, a paste and a drop from outside are sent as. */
      selectionAction?: string;
      pasteAction?: string;
      dropAction?: string;
    }
  /**
   * A canvas its plugin draws on from its worker. With `pointer`, taps and drags on it are sent to the plugin as the
   * event `canvas:pointer` (src/host/views/canvas.ts), and the page stops scrolling under a finger on it.
   */
  | { type: "canvas"; id: string; width: number; height: number; pointer?: boolean }
  /** A line diff, for change review. */
  | { type: "diff"; lines: { op: "same" | "add" | "del"; text: string }[] }
  /** A form field. The host sends `action` with the new value when the person changes it. */
  | {
      type: "field";
      name: string;
      label: string;
      kind: "text" | "number" | "checkbox" | "select" | "password";
      value: string | number | boolean;
      action: string;
      options?: string[];
      description?: string;
    };

/** Where a view goes: the name of a `<slot name>` in the page. Each app's app.html names its own; the platform's page has nav, main, side, status and devtools. */
export type Slot = string;

export interface TraceEvent {
  /** Counts up from 1 with each event, so a reader can tell which events it already has. */
  seq: number;
  at: number; // ms since kernel start
  trace?: string;
  kind: "dispatch" | "remote" | "call" | "denied" | "lifecycle" | "bridge" | "error" | "note";
  name: string;
  plugin?: string;
  ms?: number;
  detail?: string;
}

// host -> kernel
export type HostToKernel =
  /** `member` is set by a server, never by the client: who in the space's accounts this connection is. */
  | { t: "hello"; tab: string; folder?: FileSystemDirectoryHandle; member?: string }
  | SyncToSpace
  | { t: "bye"; tab: string }
  | { t: "event"; owner: string; action: string; value?: unknown; trace: string }
  | { t: "spawned"; plugin: string; port: MessagePort }
  | { t: "canvas"; owner: string; id: string; canvas: OffscreenCanvas; theme?: CanvasTheme }
  /** The theme changed: for a plugin with canvases in this tab. */
  | { t: "canvas:theme"; owner: string; theme: CanvasTheme }
  | { t: "bridge:result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "command"; name: Command; arg?: unknown; id: number }
  /** A view bound to a collection, drawn by `owner`, wants its records. */
  | { t: "bind"; id: string; owner: string; collection: string }
  | { t: "unbind"; id: string }
  /** A bound form or table saves (fields) or deletes (null) a record for `owner`. */
  | { t: "record"; id: string; owner: string; collection: string; recordId?: string; fields: Record<string, unknown> | null; trace: string }
  /**
   * The tab opened an app: the plugins its app.html links, fetched by the tab, and the app's folder
   * (`demos/trip`), whose user plugins also run. `reset` (the page's ?reset) turns any of them the
   * person turned off back on.
   */
  | { t: "open"; plugins: { href: string; source: string; runner?: string }[]; app?: string; reset?: boolean }
  /** Something went wrong in the page: a file that didn't load, an uncaught error. The kernel puts it in the trace. */
  | { t: "report"; source: string; text: string }
  /** The tab's screen, from its address: `/demos/reading-list/book/42?tab=notes` is path `/book/42`, query `{ tab: "notes" }`. Sent when the app opens and whenever it changes. */
  | { t: "url"; path: string; query: Record<string, string> };

export type Command =
  /** The workbench asks for its plugins panel, which the kernel draws only for it. */
  | "plugins-panel"
  | "bench"
  | "reload-test"
  | "reload"
  | "install"
  | "uninstall"
  | "trace"
  | "changes"
  | "sync"
  | "reference"
  | "modules"
  | "fetched"
  | "route"
  | "user:list"
  | "user:add"
  | "user:on"
  | "user:off"
  | "user:remove"
  | "user:share"
  | "user:unshare"
  | "place:ask"
  | "place:unlock"
  | "place:lock"
  | "place:move";

// kernel -> host
export type KernelToHost =
  | { t: "welcome"; tab: string; spawner: boolean; mode: "shared" | "dedicated" | "server" }
  | SyncToDevice
  | { t: "render"; slot: Slot; key: string; owner: string; order: number; view: View | null }
  | { t: "spawn"; plugin: string; source: string; network: boolean }
  | { t: "terminate"; plugin: string }
  | { t: "bridge"; id: number; service: string; method: string; args: unknown[] }
  | { t: "trace"; events: TraceEvent[] }
  | { t: "notice"; text: string; tone?: "error" | "ok" }
  | { t: "command:result"; id: number; value: unknown }
  | { t: "bound"; id: string; collection: string; title?: string; schema?: unknown; writable?: boolean; records?: Record<string, unknown>[]; error?: string }
  | { t: "record:result"; id: string; ok: boolean; recordId?: string; errors?: { path: string; message: string }[]; error?: string }
  /**
   * The app's plugins are running: each link's plugin id, or why it isn't. Sent again whenever the
   * person turns a user plugin on or off. `places` are the plugin's, `unlocked` the locked places the
   * person let it into, and `user` marks a plugin the person added rather than the app's author.
   */
  | { t: "opened"; plugins: Opened[]; components?: { tag: string; html: string }[] };

export interface Opened {
  href: string;
  id?: string;
  error?: string;
  name?: string;
  places?: Record<string, Place>;
  theme?: Record<string, string>;
  unlocked?: string[];
  /** The places the person moved somewhere else (src/kernel/moves.ts): `places` already says where. */
  moved?: string[];
  user?: boolean;
}

/**
 * Where a plugin's view goes in a page that has no slot for it: `at` is a CSS selector run against the
 * app's own page, and `put` says what happens there. The view is drawn by rendering to the place's name,
 * as to a slot. `each` uses every match instead of the first. With `in`, the selector runs inside that
 * plugin's views instead (a view transform), which needs the permission `ui:transform:<in>`.
 */
export interface Place {
  at: string;
  put: "before" | "after" | "prepend" | "append" | "replace" | "hide";
  each?: boolean;
  in?: string;
  /** Among the views placed at the same spot, lower comes first. The person sets it by moving views (src/kernel/moves.ts). */
  order?: number;
}

/** The page's theme, for drawing on a canvas: resolved colours of the platform's tokens, the font, and light or dark. */
export interface CanvasTheme {
  scheme: "light" | "dark";
  /** fg, fg-2, bg, bg-2, surface, border, accent, accent-fg, danger, ok, warn: colours a 2D context takes. */
  colors: Record<string, string>;
  font: string;
}

// kernel <-> plugin worker
export type KernelToPlugin =
  | { t: "hook"; id?: number; listener: number; name: string; args: unknown[]; trace?: string }
  | { t: "event"; action: string; value?: unknown; trace?: string }
  | { t: "canvas"; id: string; canvas: OffscreenCanvas; theme?: CanvasTheme }
  | { t: "canvas:theme"; theme: CanvasTheme }
  // `gone`: the call failed because the plugin that provides the service wasn't running to answer it.
  | { t: "result"; id: number; ok: boolean; value?: unknown; error?: string; gone?: true };

export type PluginToKernel =
  | { t: "ready"; manifest: Manifest }
  | { t: "failed"; error: string }
  | { t: "on"; listener: number; name: string }
  | { t: "off"; listener: number }
  | { t: "hook:result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "render"; slot: Slot; key: string; order?: number; view: View | null; trace?: string }
  | { t: "call"; id: number; service: string; method: string; args: unknown[]; trace?: string }
  | { t: "log"; level: "info" | "error"; text: string; trace?: string };

export interface Manifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** Capabilities: `hook:listen:notes:open`, `ui`, `audio`, ... */
  permissions: string[];
  order?: number;
  /** "shared" (default): one worker for every tab. "tab": one worker per open tab, for plugins that draw or hold view state. */
  scope?: "shared" | "tab";
  /** Where it runs: in the browser (the default), on a space's server, or both. */
  runs?: "browser" | "server" | "both";
  /** Collections this plugin owns: `{ books: { title?, schema } }`, each schema a JSON Schema subset. */
  collections?: Record<string, { title?: string; schema: unknown }>;
  /** Settings the person can change; the shell builds the form from these. */
  settings?: Record<string, { type: "string" | "number" | "boolean"; title?: string; description?: string; default?: unknown; enum?: string[] }>;
  /** Places in the app's page where the plugin draws, adds or hides, by name: `{ days: { at: "main > h1", put: "after" } }`. */
  places?: Record<string, Place>;
  /** Other files next to the plugin that it needs (its templates, images), copied with it when a person adds it to an app. */
  files?: string[];
  /** Design tokens it sets for the whole app, with the ui:theme permission: `{ "--accent": "#7c3aed" }` (shared/theme.ts). */
  theme?: Record<string, string>;
  /** Hooks it defines, by key: `{ open: { mode: "emit", args: "{ id }" } }` is the hook `<id>:open`, which only it can run. */
  hooks?: Record<string, PluginHook>;
  /**
   * What holds its place until the person first uses it, with the ui permission: `{ slot, key, html }`, the view it
   * will draw there itself. The kernel draws it, and starts the plugin at the first thing the person does in it;
   * the plugin hears that once it has drawn its own view (a panel behind a button costs an app nothing until it is opened).
   */
  standIn?: { slot: string; key: string; html: string };
  /** Services it calls that not every site runs (kernel modules, docs/layers.md): `["llm", "bus"]`. It isn't started without them. */
  services?: string[];
  /** Services it provides, by name, with the `provide:<name>` permission: `{ mail: { description, methods: { send: { args?, returns?, description, needs? } } } }` (src/kernel/provided.ts). */
  provides?: Record<string, ProvidedService>;
}

/** A service a plugin provides: what it is, and each method other plugins may call. */
export interface ProvidedService {
  description: string;
  /** Each method; `params` describes its arguments, so tools offers it to agents (MethodDoc.params). */
  methods: Record<string, { args?: string; returns?: string; description: string; needs?: string; params?: { name: string; schema: Record<string, unknown>; optional?: boolean }[] }>;
}

/** A hook a plugin defines in its manifest. The limits are the kernel's (PLUGIN_HOOKS in src/kernel/hooks.ts). */
export interface PluginHook {
  mode: "emit" | "waterfall" | "serial" | "bail" | "parallel";
  /** What listeners receive, as a reader should see it. */
  args?: string;
  description?: string;
  /** How long each listener has to answer, for serial, bail and waterfall hooks. */
  timeoutMs?: number;
  /** How long an agent that checks it has; without one, agents can't check it. */
  agentTimeoutMs?: number;
  /** "open" (the default): a listener that fails or runs out of time is skipped. "closed": it counts as a block. */
  onFailure?: "open" | "closed";
  /** Run many times a second (a game's moves): it isn't traced, unless a listener fails. */
  quiet?: boolean;
}

/** Carried as Cordis's `thisArg` on every kernel dispatch, so listeners in any worker know which action they serve. */
export interface Dispatch {
  trace?: string;
  /**
   * Set by the kernel, never by a plugin: the id of an agent acting for the person (`acts-as: person`)
   * that made this call. Reviews and the change log say the change is the person's, made through it.
   */
  via?: string;
}
