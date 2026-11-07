// Messages between the three kinds of thread:
//
//   host (page)  <-- port -->  kernel (shared worker)  <-- port -->  plugin (dedicated worker)
//
// Every message is a plain object with a `t` (type). Calls that expect an
// answer carry an `id`; the answer echoes it. Messages that run code on
// behalf of a user action carry a `trace` id so one action can be followed
// across threads.

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
  | { type: "textarea"; name: string; value: string; action: string; placeholder?: string }
  | { type: "canvas"; id: string; width: number; height: number }
  /** A line diff, for change review. */
  | { type: "diff"; lines: { op: "same" | "add" | "del"; text: string }[] }
  /** A form field. The host sends `action` with the new value when the person changes it. */
  | {
      type: "field";
      name: string;
      label: string;
      kind: "text" | "number" | "checkbox" | "select";
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
  | { t: "hello"; tab: string; folder?: FileSystemDirectoryHandle }
  | { t: "bye"; tab: string }
  | { t: "event"; owner: string; action: string; value?: unknown; trace: string }
  | { t: "spawned"; plugin: string; port: MessagePort }
  | { t: "canvas"; owner: string; id: string; canvas: OffscreenCanvas }
  | { t: "bridge:result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "command"; name: Command; arg?: unknown; id: number }
  /** A view bound to a collection, drawn by `owner`, wants its records. */
  | { t: "bind"; id: string; owner: string; collection: string }
  | { t: "unbind"; id: string }
  /** A bound form or table saves (fields) or deletes (null) a record for `owner`. */
  | { t: "record"; id: string; owner: string; collection: string; recordId?: string; fields: Record<string, unknown> | null; trace: string }
  /** The tab opened an app: the plugins its app.html links, fetched by the tab. `reset` (the page's ?reset) turns any of them the person turned off back on. */
  | { t: "open"; plugins: { href: string; source: string }[]; reset?: boolean }
  /** Something went wrong in the page: a file that didn't load, an uncaught error. The kernel puts it in the trace. */
  | { t: "report"; source: string; text: string };

export type Command = "bench" | "reload-test" | "reload" | "install" | "uninstall" | "trace" | "changes" | "reference";

// kernel -> host
export type KernelToHost =
  | { t: "welcome"; tab: string; spawner: boolean; mode: "shared" | "dedicated" }
  | { t: "render"; slot: Slot; key: string; owner: string; order: number; view: View | null }
  | { t: "spawn"; plugin: string; source: string; network: boolean }
  | { t: "terminate"; plugin: string }
  | { t: "bridge"; id: number; service: string; method: string; args: unknown[] }
  | { t: "trace"; events: TraceEvent[] }
  | { t: "notice"; text: string; tone?: "error" | "ok" }
  | { t: "command:result"; id: number; value: unknown }
  | { t: "bound"; id: string; collection: string; title?: string; schema?: unknown; writable?: boolean; records?: Record<string, unknown>[]; error?: string }
  | { t: "record:result"; id: string; ok: boolean; recordId?: string; errors?: { path: string; message: string }[]; error?: string }
  /** The app's plugins are running: each link's plugin id, or why it isn't. */
  | { t: "opened"; plugins: { href: string; id?: string; error?: string }[] };

// kernel <-> plugin worker
export type KernelToPlugin =
  | { t: "hook"; id?: number; listener: number; name: string; args: unknown[]; trace?: string }
  | { t: "event"; action: string; value?: unknown; trace?: string }
  | { t: "canvas"; id: string; canvas: OffscreenCanvas }
  | { t: "result"; id: number; ok: boolean; value?: unknown; error?: string };

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
  /** New-style capabilities (`hook:listen:data:changed`, `ui`, `audio`, ...) or editor-style permissions (`post:read`, `ui`). */
  permissions: string[];
  order?: number;
  /** "shared" (default): one worker for every tab. "tab": one worker per open tab, for plugins that draw or hold view state. */
  scope?: "shared" | "tab";
  /** Collections this plugin owns: `{ books: { title?, schema } }`, each schema a JSON Schema subset. */
  collections?: Record<string, { title?: string; schema: unknown }>;
  /** Settings the person can change; the shell builds the form from these. */
  settings?: Record<string, { type: "string" | "number" | "boolean"; title?: string; description?: string; default?: unknown; enum?: string[] }>;
}

/** Carried as Cordis's `thisArg` on every kernel dispatch, so listeners in any worker know which action they serve. */
export interface Dispatch {
  trace?: string;
}
