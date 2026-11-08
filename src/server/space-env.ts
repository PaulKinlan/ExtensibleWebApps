// A space's environment for the kernel (see src/kernel/env.ts). Each space's
// kernel runs in its own worker thread, so the kernel's module-level state is
// one space's alone. The server (serve.ts) starts the thread with the space's
// folder and the site's origin, and hands it a port for each client.

import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { setEnv } from "../kernel/env";
import { nodeFiles } from "../seams/node.ts";

const { dir, origin } = workerData as { dir: string; origin: string };

setEnv({
  kind: "server",
  origin,
  folder: nodeFiles(join(dir, "files")),
  connect(accept) {
    parentPort!.on("message", (message: { t?: string; port?: MessagePort }) => {
      if (message?.t === "connect" && message.port) accept(message.port);
    });
  },
  onError(report) {
    process.on("uncaughtException", (error) => report("kernel:error", error.message));
    process.on("unhandledRejection", (reason) => report("kernel:unhandled", String(reason instanceof Error ? reason.message : reason)));
  },
});
