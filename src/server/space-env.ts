// A space's environment for the kernel (see src/kernel/env.ts). Each space's
// kernel runs in its own worker thread, so the kernel's module-level state is
// one space's alone. The server (serve.ts) starts the thread with the space's
// folder and the site's origin, and hands it a port for each client.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { setEnv, type PushAsk, type Pushed } from "../kernel/env";
import type { Email, Message } from "../seams/index.ts";
import { nodeFiles } from "../seams/node.ts";

type DeliverResult = Awaited<ReturnType<Email["send"]>>;
import { nodeIsolates } from "../seams/node-isolates.ts";
import { makeGuardedFetch } from "./network-guard.ts";

const { dir, origin, allowPrivate, deploymentSecrets: givenSecrets } = workerData as { dir: string; origin: string; allowPrivate?: string[]; deploymentSecrets?: unknown };

const SECRET_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const SECRET_HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/;

function parseHosts(raw: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) list = parsed;
      } catch {}
    } else list = trimmed.split(",");
  }
  return list.filter((h): h is string => typeof h === "string").map((h) => h.trim().toLowerCase()).filter((h) => SECRET_HOST.test(h));
}

function deploymentSecret(name: string): { value: string; hosts: string[]; dailyCap?: number } | undefined {
  if (!SECRET_NAME.test(name)) return undefined;
  const vars = process.env;
  const defaultCap = typeof vars.DEPLOYMENT_SECRET_DAILY_CAP === "string" && /^\d+$/.test(vars.DEPLOYMENT_SECRET_DAILY_CAP) ? Number(vars.DEPLOYMENT_SECRET_DAILY_CAP) : undefined;
  for (const source of [givenSecrets, vars.DEPLOYMENT_SECRETS]) {
    if (!source) continue;
    let map: unknown = source;
    if (typeof map === "string") {
      try {
        map = JSON.parse(map);
      } catch {
        continue;
      }
    }
    if (!map || typeof map !== "object" || Array.isArray(map) || !Object.hasOwn(map, name)) continue;
    const entry = (map as Record<string, unknown>)[name] as { value?: unknown; hosts?: unknown; dailyCap?: unknown } | undefined;
    if (!entry || typeof entry !== "object" || typeof entry.value !== "string" || !entry.value) continue;
    const hosts = parseHosts(entry.hosts);
    if (!hosts.length) continue;
    const cap = typeof entry.dailyCap === "number" && Number.isFinite(entry.dailyCap) && entry.dailyCap >= 0 ? Math.floor(entry.dailyCap) : defaultCap;
    return { value: entry.value, hosts, ...(cap !== undefined && { dailyCap: cap }) };
  }
  const key = name.toUpperCase().replace(/-/g, "_");
  const value = vars[`EWA_SECRET_${key}`] ?? vars[`EWA_SECRET_${name}`];
  const rawHosts = vars[`EWA_SECRET_${key}_HOSTS`] ?? vars[`EWA_SECRET_${name}_HOSTS`];
  if (typeof value !== "string" || !value) return undefined;
  const hosts = parseHosts(rawHosts);
  if (!hosts.length) return undefined;
  const rawCap = vars[`EWA_SECRET_${key}_DAILY_CAP`] ?? vars[`EWA_SECRET_${name}_DAILY_CAP`];
  const cap = typeof rawCap === "string" && /^\d+$/.test(rawCap) ? Number(rawCap) : defaultCap;
  return { value, hosts, ...(cap !== undefined && { dailyCap: cap }) };
}

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
  allowPrivate,
  deploymentSecrets: deploymentSecret,
  fetch: makeGuardedFetch(allowPrivate ?? []),
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
  // serve.ts sends notifications to members' devices (src/server/auth/push.ts): the accounts keep their subscriptions.
  push: (note: PushAsk) => askServer<Pushed>("push", { sent: 0, devices: 0, people: 0, reached: 0, problems: ["The server didn't answer"] }, { note }),
  // serve.ts keeps MCP clients' streams open, and asks their door again when told (src/server/mcp.ts).
  changed: (door: string) => parentPort!.postMessage({ t: "changed", door }),
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
