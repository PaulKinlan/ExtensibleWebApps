// A space's environment for the kernel (see src/kernel/env.ts). Each space's
// kernel runs in its own worker thread, so the kernel's module-level state is
// one space's alone. The server (serve.ts) starts the thread with the space's
// folder and the site's origin, and hands it a port for each client.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { setEnv } from "../kernel/env";
import type { Email, Message } from "../seams/index.ts";
import { nodeFiles } from "../seams/node.ts";

type DeliverResult = Awaited<ReturnType<Email["send"]>>;
import { nodeIsolates } from "../seams/node-isolates.ts";

const { dir, origin, allowPrivate } = workerData as { dir: string; origin: string; allowPrivate?: string[] };

/** The kernel's asks of the server (its members' addresses and names), numbered so each answer finds its ask. */
let asked = 0;

/** Asks serve.ts something only it knows (the accounts, which the space's thread can't read): `t` names it, and the answer comes back as `value`. */
function askServer<T>(t: string, fallback: T, payload: Record<string, unknown> = {}): Promise<T> {
  const id = ++asked;
  return new Promise<T>((done) => {
    const answer = (m: { t?: string; id?: number; value?: T }) => {
      if (m?.t !== t || m.id !== id) return;
      parentPort!.off("message", answer);
      done(m.value ?? fallback);
    };
    parentPort!.on("message", answer);
    parentPort!.postMessage({ ...payload, t, id });
  });
}

setEnv({
  kind: "server",
  origin,
  folder: nodeFiles(join(dir, "files")),
  // Each of the space's plugins in a process of its own, from the runtime built beside this file.
  isolates: nodeIsolates(fileURLToPath(new URL("./isolate.js", import.meta.url)), { allowPrivate }),
  connect(accept) {
    parentPort!.on("message", (message: { t?: string; port?: MessagePort }) => {
      if (message?.t === "connect" && message.port) accept(message.port);
    });
  },
  boot(start) {
    // serve.ts starts a space with jobs when the server starts (std/schedule/module.ts): the
    // kernel's folder is ready at once on Node, so it starts as soon as it has loaded.
    setImmediate(start);
  },
  addresses: () => askServer<string[]>("addresses", []),
  members: () => askServer<{ id: string; name: string }[]>("members", []),
  // serve.ts delivers mail when the deployment has SMTP (src/server/smtp.ts); without it, it stays in the outbox.
  ...(workerData.email ? { deliver: (message: Message) => askServer<DeliverResult>("deliver", { ok: false, error: "The server didn't answer" }, { message }) } : {}),
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
