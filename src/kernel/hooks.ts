// Hook specs. A hook's dispatch mode, time limit and failure policy are part
// of its contract; listeners in other workers are held to them by the bridge.

export type Mode = "emit" | "waterfall" | "serial" | "bail" | "parallel";

export interface HookSpec {
  mode: Mode;
  /** Per remote listener. */
  timeoutMs?: number;
  /**
   * How long an agent that checks this hook (`- check:` in its file) has to
   * answer, since a model takes seconds. A hook without one can't be checked
   * by agents, which keeps hot paths fast.
   */
  agentTimeoutMs?: number;
  /** "open": skip a listener that fails or times out. "closed": treat it as a block. */
  onFailure?: "open" | "closed";
  description?: string;
  /** What listeners receive, as a reader should see it. */
  args?: string;
  /** The capability listening needs, when it isn't the usual `hook:listen:<name>` or `hook:intercept:<name>`. */
  needs?: string;
  /**
   * A hot path, run many times a second (a game's tick, std/game/module.ts): its dispatches and its listeners'
   * answers aren't traced, so they don't push everything else out of the trace. A listener that fails is.
   */
  quiet?: boolean;
}

export const hooks = new Map<string, HookSpec>();

/**
 * The limits on hooks a plugin defines in its manifest's `hooks`, in one place so they can change:
 * how many, how long each listener may take, and how long an agent that checks one may take. These are
 * the defaults: a site changes any of them in kernel.json's `hooks` (`{ "timeoutMs": 10000 }`), which the
 * build checks (vite.kernel-modules.ts) and the kernel applies as it starts.
 */
export const PLUGIN_HOOKS = {
  max: 20,
  /** A listener's limit when the manifest gives none, for hooks that wait for an answer. */
  defaultTimeoutMs: 1000,
  /** The most `timeoutMs` may be. */
  timeoutMs: 5000,
  /** The most `agentTimeoutMs` may be. */
  agentTimeoutMs: 30_000,
  /** The most a value sent with ctx.hooks may be, in characters of JSON. */
  maxValue: 1_000_000,
};

/** The plugin that defined each plugin hook, `<plugin>:<key>`. The kernel's own hooks aren't in here. */
export const hookOwners = new Map<string, string>();

/** Hook names the kernel reads in its own way: a plugin with one of these ids can't define hooks. */
const SPECIAL = ["command", "schedule", "route", "internal", "service"];

/** True if `<id>:` starts any of the kernel's own hooks, so a plugin with that id can't define hooks of its own. */
export function kernelPrefix(id: string): boolean {
  if (SPECIAL.includes(id)) return true;
  for (const name of hooks.keys()) if (name.startsWith(`${id}:`) && !hookOwners.has(name)) return true;
  return false;
}

/** Every collection's `data:beforeWrite:<collection>`: plugins get a second, an agent that checks it 15. */
export const BEFORE_WRITE: HookSpec = { mode: "serial", timeoutMs: 1000, agentTimeoutMs: 15_000, onFailure: "open" };

export function defineHook(name: string, spec: HookSpec): () => void {
  if (hooks.has(name)) throw new Error(`Hook ${name} is already defined`);
  hooks.set(name, spec);
  return () => hooks.delete(name);
}

/** Listening to a hook that can change or stop an action needs the intercept capability. */
export function capabilityFor(name: string): string {
  const spec = hooks.get(name);
  if (spec?.needs) return spec.needs;
  const mode = spec?.mode;
  return mode === "emit" || mode === "parallel" ? `hook:listen:${name}` : `hook:intercept:${name}`;
}
