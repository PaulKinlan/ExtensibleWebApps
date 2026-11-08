// On a server, the kernel's own client that starts its plugins. In a browser
// a tab (the spawner) starts each plugin's worker and hands the kernel a port;
// a space's kernel has no tab of its own, so this stands in for one: it
// connects like a tab, and when the kernel asks it to spawn a plugin, it
// starts the plugin in an isolate (the host's seam, src/seams/index.ts) and
// hands back that port. Hosts (hosts.ts) makes it the spawner.

import type { Isolates } from "../seams/index.ts";
import type { HostToKernel, KernelToHost } from "../shared/protocol";
import { record } from "./trace";

export function isolateHost(isolates: Isolates, connect: (port: MessagePort) => void): void {
  const { port1, port2 } = new MessageChannel();
  connect(port1);
  const send = (message: HostToKernel, transfer: Transferable[] = []) => port2.postMessage(message, transfer);
  port2.onmessage = async (e: MessageEvent<KernelToHost>) => {
    const message = e.data;
    if (message.t === "spawn") {
      try {
        const port = (await isolates.start(message.plugin, message.source, { network: message.network })) as unknown as MessagePort;
        send({ t: "spawned", plugin: message.plugin, port }, [port]);
      } catch (error) {
        record({ kind: "error", name: "plugin:isolate", plugin: message.plugin, detail: String(error instanceof Error ? error.message : error) });
      }
    } else if (message.t === "terminate") isolates.stop(message.plugin);
  };
  port2.start();
  send({ t: "hello", tab: "server" });
}
