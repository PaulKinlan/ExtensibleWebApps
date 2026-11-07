// Plugin routes: the kernel's side of sw/routes/plugins.js.
//
// A plugin adds a route with ctx.routes.add(method, path, handler); remote.ts
// checks it is inside the plugin's folder and listens to the bail hook
// `route:<METHOD> <absolute path>`. This file keeps the service worker's copy
// of the table up to date, and answers a request the service worker passes on
// (through a tab, as the "route" command) by dispatching that hook.

import type { RemotePlugins } from "./remote";
import { record } from "./trace";

/** What the service worker sends: the request, as plain values. */
export interface RouteRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  form?: unknown;
}

/** What a handler may return. Anything else is dropped. */
export interface RouteResponse {
  status?: number;
  redirect?: string;
  html?: string;
  json?: unknown;
  text?: string;
}

const MAX = 1_000_000;

export function makeRoutes(root: any, remote: RemotePlugins) {
  const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("platform:routes");

  /** Shares the table: a broadcast for a running service worker, and the cache for one that starts later. */
  function publish(): void {
    const table = remote.routes;
    channel?.postMessage(table);
    if (typeof caches === "undefined") return;
    void caches
      .open("platform-routes")
      .then((cache) => cache.put("/routes.json", new Response(JSON.stringify(table), { headers: { "Content-Type": "application/json" } })))
      .catch(() => {});
  }
  remote.onRoutes = publish;
  // A new kernel has no routes yet: whatever an earlier one shared is gone.
  publish();

  async function answer(arg: unknown): Promise<RouteResponse | null> {
    const request = arg as RouteRequest;
    if (!request || typeof request.method !== "string" || typeof request.path !== "string") return null;
    const name = `route:${request.method} ${request.path}`;
    const trace = `route-${Math.random().toString(36).slice(2, 8)}`;
    const started = performance.now();
    const result = (await root.bail({ trace }, name, { method: request.method, path: request.path, query: request.query ?? {}, form: request.form })) as RouteResponse | undefined;
    const out = clean(result);
    record({ kind: "dispatch", name, trace, ms: Math.round((performance.now() - started) * 100) / 100, detail: out ? Object.keys(out).join(", ") : "no plugin answered" });
    return out;
  }

  return { answer };
}

/** Only the fields the service worker understands, within size. */
function clean(result: RouteResponse | undefined): RouteResponse | null {
  if (!result || typeof result !== "object") return null;
  const out: RouteResponse = {};
  if (Number.isInteger(result.status)) out.status = result.status;
  if (typeof result.redirect === "string") out.redirect = result.redirect.slice(0, 2000);
  else if (typeof result.html === "string") out.html = result.html.slice(0, MAX);
  else if (result.json !== undefined) {
    const json = JSON.stringify(result.json);
    if (json.length > MAX) return { status: 500, text: "The plugin's answer was too large" };
    out.json = JSON.parse(json);
  } else out.text = String(result.text ?? "").slice(0, MAX);
  return out;
}
