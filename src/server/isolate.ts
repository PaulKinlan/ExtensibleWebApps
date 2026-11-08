// A plugin's sandbox on a Node server: the process src/seams/node-isolates.ts
// starts for one plugin, with Node's permission model on. It makes Node look
// enough like a browser's worker for the plugin runtime (src/sandbox/runtime.ts),
// then takes away what a plugin mustn't have: Node's own modules (files,
// sockets, processes), `process` itself, and, unless the plugin has
// `network`, fetch and WebSocket. With `network`, it can reach the internet but
// not the server's own network (network-guard.ts). Messages to and from the
// kernel cross the process's IPC channel.

import { builtinModules, registerHooks } from "node:module";
import { guardNetwork } from "./network-guard";

// A plugin's module is a data: URL, and it may import only other data: URLs: not Node's modules
// (files, sockets, processes), and not files. The check is made with copies of the built-ins it needs,
// taken now: a plugin can replace String.prototype.startsWith for everyone, but not these.
const builtins: Record<string, true> = Object.create(null);
for (const m of builtinModules) builtins[m] = builtins[`node:${m}`] = true;
const startsWith = Function.prototype.call.bind(String.prototype.startsWith) as (s: string, prefix: string) => boolean;
const isData = (url: unknown) => typeof url === "string" && startsWith(url, "data:");
registerHooks({
  resolve(specifier, context, next) {
    if (isData(context.parentURL) && (builtins[specifier] === true || !isData(specifier))) throw new Error(`A plugin can't import ${specifier}`);
    return next(specifier, context);
  },
});

const node = process;
const toKernel = (message: unknown) => node.send?.(message);
type Listener = (event: any) => void;
const listeners = new Map<string, Set<Listener>>();
const fire = (type: string, event: unknown) => {
  for (const listener of listeners.get(type) ?? []) listener(event);
};
// The kernel's gone (its thread stopped, or the server did): so is this.
node.on("disconnect", () => node.exit(0));
node.on("uncaughtException", (error) => fire("error", { message: error.message }));
node.on("unhandledRejection", (reason) => fire("unhandledrejection", { reason }));

/** The kernel's end, as the runtime sees a MessagePort. */
const port = {
  onmessage: null as Listener | null,
  postMessage: (message: unknown) => toKernel(message),
  start() {},
  close() {},
};

const self = globalThis as any;
self.self = globalThis;
self.addEventListener = (type: string, listener: Listener) => listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
// A plugin's source is loaded as a module from a data: URL; Node can't import blob: URLs.
self.__moduleUrl = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

let started = false;
async function handle(message: any) {
  if (!started && message?.t === "init") {
    started = true;
    if (!message.network) for (const name of ["fetch", "WebSocket", "EventSource"]) delete self[name];
    else await guardNetwork(Array.isArray(message.allow) ? message.allow : []);
    // Gone before the plugin's code runs: process.binding, process.env, process.kill and the rest.
    delete self.process;
    self.onmessage?.({ data: { t: "init", source: String(message.source) }, ports: [port] });
    return;
  }
  port.onmessage?.({ data: message });
}

// One at a time, in order: init may wait for the network guard, and what follows must wait for init.
let queue = Promise.resolve();
const inTurn = (message: unknown) => (queue = queue.then(() => handle(message)).catch((error) => fire("error", { message: String(error?.message ?? error) })));
// The kernel may send before the runtime has loaded (and set self.onmessage): those wait until it has.
const early: unknown[] = [];
let loaded = false;
node.on("message", (message: unknown) => (loaded ? inTurn(message) : early.push(message)));
await import("../sandbox/runtime");
loaded = true;
for (const message of early.splice(0)) inTurn(message);
