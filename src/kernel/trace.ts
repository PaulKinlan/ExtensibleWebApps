// The observability tap. Cordis reports every dispatch through
// `internal/dispatch`; the bridge and the gate add remote timings and
// denials. Events go to a ring buffer and, batched, to every open host.

import type { TraceEvent } from "../shared/protocol";

const start = performance.now();
const LIMIT = 500;
const buffer: TraceEvent[] = [];
let pending: TraceEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let sink: ((events: TraceEvent[]) => void) | undefined;

/** The trace id of the action being handled right now (set around synchronous dispatches). */
export let currentTrace: string | undefined;

export function withTrace<T>(trace: string | undefined, fn: () => T): T {
  const previous = currentTrace;
  currentTrace = trace;
  try {
    return fn();
  } finally {
    currentTrace = previous;
  }
}

export function record(event: Omit<TraceEvent, "at">): void {
  const full: TraceEvent = { at: Math.round((performance.now() - start) * 10) / 10, trace: currentTrace, ...event };
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

/** Mounts the tap on a Cordis root: every non-internal dispatch is recorded. */
export function tap(root: any): void {
  root.on("internal/dispatch", (mode: string, name: string | symbol) => {
    if (typeof name !== "string" || name.startsWith("internal/")) return;
    record({ kind: "dispatch", name, detail: mode });
  });
}
