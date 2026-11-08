// The isolate seam on Node: each plugin of a space runs in a process of its
// own, started with Node's permission model (--permission), so it can't read
// or write files, start processes or workers, or load native code. Its
// runtime (src/server/isolate.ts, built to .build/server/isolate.js) also
// keeps it from importing Node's own modules, and takes away fetch and
// WebSocket unless the plugin has `network`. Messages cross the process's IPC
// channel, cloned as a worker's are.
//
// Cloudflare's isolates are stronger (a Dynamic Worker with no outbound
// network at all); this is the development and self-hosting host.

import { type ChildProcess, fork } from "node:child_process";
import { dirname, resolve } from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { Isolates } from "./index.ts";

export function nodeIsolates(runtime: string): Isolates {
  const file = resolve(runtime);
  const running = new Map<string, { child: ChildProcess; port: MessagePort }>();

  function stop(name: string) {
    const one = running.get(name);
    if (!one) return;
    running.delete(name);
    one.port.close();
    one.child.kill();
  }

  return {
    async start(name, source, { network }) {
      stop(name);
      const child = fork(file, [], {
        // It may read its own runtime (beside it, in the build folder), and nothing else.
        execArgv: ["--permission", `--allow-fs-read=${dirname(file)}/*`, "--no-warnings"],
        // Nothing of the server's: no environment (keys live there), no input.
        env: {},
        serialization: "advanced",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      const { port1, port2 } = new MessageChannel();
      port1.on("message", (message: unknown) => {
        if (child.connected) child.send(message as Parameters<ChildProcess["send"]>[0]);
      });
      child.on("message", (message: unknown) => port1.postMessage(message));
      child.on("exit", () => {
        if (running.get(name)?.child === child) running.delete(name);
        port1.close();
      });
      running.set(name, { child, port: port1 });
      child.send({ t: "init", source, network });
      return port2;
    },
    stop,
    stopAll() {
      for (const name of [...running.keys()]) stop(name);
    },
  };
}
