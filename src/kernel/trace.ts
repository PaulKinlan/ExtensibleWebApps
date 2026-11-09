// The observability tap. Cordis reports every dispatch through
// `internal/dispatch`, including the `thisArg` the dispatcher passed; the
// kernel always passes a `Dispatch` ({ trace }) there, so each event carries
// the id of the action it belongs to, across awaits and across workers. The
// bridge and the gate add remote timings and denials. Events go to a ring
// buffer and, batched, to every open tab and to plugins that hold
// `debug:read` (through the `debug:trace` hook).

import type { Dispatch, TraceEvent } from "../shared/protocol";
import { hooks } from "./hooks";

const start = performance.now();
/** When the kernel started, as wall-clock time: an event's `at` counts from here. */
export const startedAt = Date.now();
const LIMIT = 500;
const buffer: TraceEvent[] = [];
let pending: TraceEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let sink: ((events: TraceEvent[]) => void) | undefined;

let seq = 0;

export function record(event: Omit<TraceEvent, "at" | "seq">): void {
  const full: TraceEvent = { seq: ++seq, at: Math.round((performance.now() - start) * 10) / 10, ...event };
  if (full.trace === undefined) delete full.trace;
  buffer.push(full);
  if (buffer.length > LIMIT) buffer.shift();
  pending.push(full);
  flushTimer ??= setTimeout(flush, 100);
}

function flush() {
  flushTimer = undefined;
  const events = pending;
  pending = [];
  if (events.length) sink?.(events);
}

export function setSink(fn: (events: TraceEvent[]) => void): void {
  sink = fn;
}

export function recent(): TraceEvent[] {
  return buffer.slice();
}

/** Mounts the tap on a Cordis root: every non-internal dispatch is recorded with its trace id. */
export function tap(root: any): void {
  root.on("internal/dispatch", (mode: string, name: string | symbol, _args: unknown[], thisArg: Dispatch | null) => {
    // `debug:` hooks carry the trace itself; recording them would trace the trace, forever.
    if (typeof name !== "string" || name.startsWith("internal/") || name.startsWith("debug:")) return;
    // A quiet hook runs many times a second (a game's tick): tracing each would leave room for nothing else.
    if (hooks.get(name)?.quiet) return;
    record({ kind: "dispatch", name, detail: mode, trace: thisArg?.trace });
  });
}
