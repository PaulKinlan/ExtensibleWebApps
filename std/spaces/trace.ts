// The space's trace, streamed to a member's debugger as it happens.
//
// reflect.ts answers questions about what runs in the space's kernel; this
// sends what that kernel does, event by event: each hook its server plugins
// hear, each call, refusal and error, each worker started or stopped.
//
//   page  ctx.call("sync", "trace", true)         needs reflect:read (service.ts)
//    → device.ts sends { op: "trace", on: true }  on the member's own socket
//    ← { op: "trace", events: [the last few hundred], on: true } at once,
//      then { op: "trace", events } with each new batch (at most ten a second)
//    → the device's kernel emits sync:trace { events }, which needs reflect:read
//
// Who may hear it: a member, as for reflect, since only members open the
// space's socket, and only from a plugin given reflect:read on their own
// device. The events are the ones the space's own debug:trace hook carries:
// names, plugins, timings and short details, never a record's contents or a
// secret. A device that never asks gets none of it: the kernel doesn't send
// its trace to the sockets of a space's members otherwise (src/kernel/kernel.ts).

import type { TraceEvent } from "../../src/shared/protocol";
import type { TraceRequest } from "../../src/shared/sync";
import type { Host, Hosts } from "../../src/kernel/hosts";
import { recent, record } from "../../src/kernel/trace";

/** The events a debugger gets first, from before it asked. */
const BACKLOG = 300;
/** Devices that may hear the trace at once. */
const MAX_WATCHERS = 20;

/** On a space's server: the devices hearing its trace, and the batches sent to them. */
export function spaceTrace(root: { on(name: string, listener: (events: TraceEvent[]) => void): () => void }, hosts: Hosts) {
  const watching = new Set<Host>();
  // What sending the trace itself traces would come back in the next batch, forever: those notes aren't sent.
  const ours = (e: TraceEvent) => e.name !== "trace:space";
  const off = root.on("debug:trace", (events: TraceEvent[]) => {
    if (!watching.size) return;
    const batch = events.filter(ours);
    if (!batch.length) return;
    for (const host of watching) hosts.send(host, { t: "sync", op: "trace", events: batch });
  });
  return {
    handle(host: Host, message: TraceRequest) {
      if (message.on !== true) {
        watching.delete(host);
        return hosts.send(host, { t: "sync", op: "trace", on: false });
      }
      if (!watching.has(host) && watching.size >= MAX_WATCHERS) return hosts.send(host, { t: "sync", op: "trace", on: false, error: "Too many debuggers are watching this space" });
      const first = !watching.has(host);
      watching.add(host);
      if (first) record({ kind: "note", name: "trace:space", detail: `streamed to ${host.member ?? "a member"}` });
      hosts.send(host, { t: "sync", op: "trace", on: true, events: recent().filter(ours).slice(-BACKLOG) });
    },
    left(host: Host) {
      watching.delete(host);
    },
    stop() {
      off();
      watching.clear();
    },
  };
}
