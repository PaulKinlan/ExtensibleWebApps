// A plugin's sandbox on Cloudflare: a Dynamic Worker of its own, which the
// space's supervisor (worker.ts) loads with the plugin's source beside this
// file as plugin.js, and runs as a facet so it lives as long as the space
// does. The supervisor loads it with no outbound network (globalOutbound:
// null) unless the plugin has `network`, and with nothing in its env: no
// bindings, no keys, no storage of the space's. Its compatibility flags turn
// Node's compatibility off, so it has no `process` and no node: modules either.
//
// Inside, it looks enough like a browser's worker for the plugin runtime
// (src/sandbox/runtime.ts), with the kernel at the other end of its port.

import { DurableObject } from "cloudflare:workers";

type Send = ((message: unknown) => unknown) & { dup?: () => Send };
type Listener = ((e: { data: unknown }) => void) | null;

const self = globalThis as any;
let toKernel: Send | undefined;
let chain: Promise<unknown> = Promise.resolve();

/** The kernel's end, as the runtime sees a MessagePort: each message waits for the one before. */
const port = {
  onmessage: null as Listener,
  postMessage(message: unknown) {
    const send = toKernel;
    if (send) chain = chain.then(() => send(message)).catch(() => {});
  },
  start() {},
  close() {},
};

/** Deletes globals from the global object and its prototypes (the runtime's are on the prototype). */
function remove(names: string[]) {
  for (let o: object | null = globalThis; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const name of names) if (Object.hasOwn(o, name)) Reflect.deleteProperty(o, name);
  }
}

export class PluginIsolate extends DurableObject {
  /** Runs the plugin (plugin.js, beside this module), sending what it says with `send`. */
  async start(source: string, network: boolean, send: Send): Promise<void> {
    if (toKernel) return;
    // A function passed over RPC lasts only as long as the call, unless it is kept with dup().
    toKernel = send.dup?.() ?? send;
    // globalOutbound: null already stops these reaching anything; without them a plugin can tell it has no network.
    if (!network) remove(["fetch", "WebSocket", "EventSource"]);
    // The runtime listens for its own uncaught errors; whatever this runtime doesn't let it hear, it does without.
    const listen = self.addEventListener?.bind(self);
    self.addEventListener = (type: string, listener: (e: unknown) => void) => {
      try {
        listen?.(type, listener);
      } catch {}
    };
    // The plugin's module is already here, by name: there are no blob: or data: URLs to import.
    self.__moduleUrl = () => "./plugin.js";
    await import("../../sandbox/runtime");
    self.onmessage?.({ data: { t: "init", source }, ports: [port] });
  }

  /** A message from the kernel. */
  async deliver(message: unknown): Promise<void> {
    port.onmessage?.({ data: message });
  }
}

export default {
  fetch: () => new Response("A plugin answers its space only", { status: 404 }),
};
