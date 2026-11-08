// A space's environment for the kernel (see src/kernel/env.ts). Each space's
// kernel runs in its own worker thread, so the kernel's module-level state is
// one space's alone. The server (serve.ts) starts the thread with the space's
// folder and the site's origin, and hands it a port for each client.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { setEnv } from "../kernel/env";
import { nodeFiles } from "../seams/node.ts";
import { nodeIsolates } from "../seams/node-isolates.ts";

const { dir, origin } = workerData as { dir: string; origin: string };

setEnv({
  kind: "server",
  origin,
  folder: nodeFiles(join(dir, "files")),
  // Each of the space's plugins in a process of its own, from the runtime built beside this file.
  isolates: nodeIsolates(fileURLToPath(new URL("./isolate.js", import.meta.url))),
  connect(accept) {
    parentPort!.on("message", (message: { t?: string; port?: MessagePort }) => {
      if (message?.t === "connect" && message.port) accept(message.port);
    });
  },
  boot(start) {
    // serve.ts starts a space with jobs when the server starts (src/kernel/services/schedule.ts): the
    // kernel's folder is ready at once on Node, so it starts as soon as it has loaded.
    setImmediate(start);
  },
  serve(answer) {
    // A public route's request, which serve.ts passes on (src/server/routes.ts).
    parentPort!.on("message", async (message: { t?: string; id?: number; request?: Parameters<typeof answer>[0] }) => {
      if (message?.t !== "route" || !message.request) return;
      let result: Awaited<ReturnType<typeof answer>> = null;
      try {
        result = await answer(message.request);
      } catch (error) {
        result = { status: 500, text: error instanceof Error ? error.message : String(error) };
      }
      parentPort!.postMessage({ t: "routed", id: message.id, result });
    });
  },
  onError(report) {
    process.on("uncaughtException", (error) => report("kernel:error", error.message));
    process.on("unhandledRejection", (reason) => report("kernel:unhandled", String(reason instanceof Error ? reason.message : reason)));
  },
});
