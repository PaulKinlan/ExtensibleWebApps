// On a server, the kernel's own client that starts its plugins. In a browser
// a tab (the spawner) starts each plugin's worker and hands the kernel a port;
// a space's kernel has no tab of its own, so this stands in for one: it
// connects like a tab, and when the kernel asks it to spawn a plugin, it
// starts the plugin in an isolate (the host's seam, src/seams/index.ts) and
// hands back that port. Hosts (hosts.ts) makes it the spawner.
//
// It talks to the kernel over an in-memory pair of ports, not a
// MessageChannel, so the plugin's port is handed over as it is: Cloudflare's
// runtime can't transfer a port in a message, and its isolates' ports aren't
// MessagePorts at all (src/seams/remote-isolates.ts).

import type { Isolates } from "../seams/index.ts";
import type { HostToKernel, KernelToHost } from "../shared/protocol";
import { record } from "./trace";

type Listener = ((e: { data: unknown }) => void) | null;

/** Two ends that pass each message as it is, a turn later, in order. */
function pair() {
  const end = () => {
    const self = {
      onmessage: null as Listener,
      other: undefined as unknown as { onmessage: Listener },
      closed: false,
      postMessage(data: unknown) {
        if (!self.closed) queueMicrotask(() => self.other.onmessage?.({ data }));
      },
      start() {},
      close() {
        self.closed = true;
      },
    };
    return self;
  };
  const a = end();
  const b = end();
  a.other = b;
  b.other = a;
  return [a, b] as const;
}

export function isolateHost(isolates: Isolates, connect: (port: MessagePort) => void): void {
  const [port1, port2] = pair();
  connect(port1 as unknown as MessagePort);
  const send = (message: HostToKernel) => port2.postMessage(message);
  port2.onmessage = async (e) => {
    const message = e.data as KernelToHost;
    if (message.t === "spawn") {
      try {
        const port = (await isolates.start(message.plugin, message.source, { network: message.network })) as unknown as MessagePort;
        send({ t: "spawned", plugin: message.plugin, port });
      } catch (error) {
        record({ kind: "error", name: "plugin:isolate", plugin: message.plugin, detail: String(error instanceof Error ? error.message : error) });
      }
    } else if (message.t === "terminate") isolates.stop(message.plugin);
  };
  send({ t: "hello", tab: "server" });
}
