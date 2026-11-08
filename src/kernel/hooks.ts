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
}

export const hooks = new Map<string, HookSpec>();

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
