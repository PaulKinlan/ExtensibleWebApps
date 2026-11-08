// The isolate seam where each plugin runs somewhere else, reached by calls
// rather than a MessagePort: on Cloudflare, the space's supervisor
// (src/server/cloudflare/worker.ts) starts each plugin as a Dynamic Worker of
// its own, with no network unless it has `network`, and the kernel reaches it
// over RPC. This turns those calls back into a port, as the kernel expects.
//
// Messages keep their order both ways: each one waits for the one before it.

import type { IsolatePort, Isolates } from "./index.ts";

/** Where the plugins run, as the kernel calls it. `send` is how a plugin's messages come back. */
export interface IsolateHost {
  start(name: string, source: string, network: boolean, send: (message: unknown) => void): Promise<void>;
  post(name: string, message: unknown): Promise<void>;
  stop(name: string): Promise<void>;
}

type Listener = ((e: { data: unknown }) => void) | null;

/** The kernel's end of one plugin: it holds what the plugin says until the kernel listens. */
function port(post: (message: unknown) => Promise<void>, onError: (error: unknown) => void) {
  let listener: Listener = null;
  let started = false;
  let closed = false;
  const held: unknown[] = [];
  let chain = Promise.resolve();
  const flush = () => {
    while (started && listener && held.length) listener({ data: held.shift() });
  };
  return {
    get onmessage() {
      return listener;
    },
    set onmessage(fn: Listener) {
      listener = fn;
      started = true;
      flush();
    },
    start() {
      started = true;
      flush();
    },
    postMessage(message: unknown) {
      if (closed) return;
      // Checked again when its turn comes: a message queued before the plugin stopped isn't sent to the next one.
      chain = chain.then(() => (closed ? undefined : post(message))).catch(onError);
    },
    close() {
      closed = true;
    },
    /** A message from the plugin. */
    receive(message: unknown) {
      if (closed) return;
      held.push(message);
      flush();
    },
  };
}

export function remoteIsolates(host: IsolateHost, onError: (name: string, error: unknown) => void = () => {}): Isolates {
  const running = new Map<string, ReturnType<typeof port>>();

  function stop(name: string) {
    const one = running.get(name);
    if (!one) return;
    running.delete(name);
    one.close();
    host.stop(name).catch((error) => onError(name, error));
  }

  return {
    async start(name, source, { network }) {
      stop(name);
      const end = port(
        (message) => host.post(name, message),
        (error) => onError(name, error),
      );
      running.set(name, end);
      await host.start(name, source, network, (message) => end.receive(message));
      return end as IsolatePort;
    },
    stop,
    stopAll() {
      for (const name of [...running.keys()]) stop(name);
    },
  };
}
