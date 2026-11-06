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
  | { type: "stack"; children: View[]; direction?: "row" | "column" }
  | { type: "heading"; text: string }
  | { type: "text"; text: string; title?: string; tone?: "muted" | "error" | "ok" }
  | { type: "button"; label: string; action: string; primary?: boolean }
  | { type: "list"; items: { label: string; action: string; selected?: boolean }[] }
  | { type: "textarea"; name: string; value: string; action: string; placeholder?: string }
  | { type: "canvas"; id: string; width: number; height: number };

export type Slot = "app.nav" | "app.main" | "app.side" | "statusbar" | "devtools";

export interface TraceEvent {
  at: number; // ms since kernel start
  trace?: string;
  kind: "dispatch" | "remote" | "denied" | "lifecycle" | "bridge" | "error" | "note";
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
  | { t: "command"; name: "bench" | "reload-test" | "reload" | "install"; arg?: unknown; id: number };

// kernel -> host
export type KernelToHost =
  | { t: "welcome"; tab: string; spawner: boolean; mode: "shared" | "dedicated" }
  | { t: "render"; slot: Slot; key: string; owner: string; order: number; view: View | null }
  | { t: "spawn"; plugin: string; source: string; network: boolean }
  | { t: "terminate"; plugin: string }
  | { t: "bridge"; id: number; service: string; method: string; args: unknown[] }
  | { t: "trace"; events: TraceEvent[] }
  | { t: "notice"; text: string; tone?: "error" | "ok" }
  | { t: "command:result"; id: number; value: unknown };

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
  /** Settings the person can change; the shell builds the form from these. */
  settings?: Record<string, { type: "string" | "number" | "boolean"; title?: string; description?: string; default?: unknown; enum?: string[] }>;
}

/** Carried as Cordis's `thisArg` on every kernel dispatch, so listeners in any worker know which action they serve. */
export interface Dispatch {
  trace?: string;
}
