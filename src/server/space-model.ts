// A model key a space holds for its members: the routes both hosts answer
// before the accounts do (as for moving a space, transfer.ts).
//
//   GET    /auth/spaces/<name>/model       whether the space has a key, whose, and for which vendor (members)
//   POST   /auth/spaces/<name>/model       asks the model, with the space's key (members): { request } or { models: true }
//   POST   /auth/spaces/<name>/model/key   gives the space a key: { vendor, key } (its owner only)
//   DELETE /auth/spaces/<name>/model/key   takes it away (its owner only); so does POST with { remove: true }
//
// The key is used by the space's own kernel (std/spaces/model-key.ts), which
// these reach through its `model` door: the host says who is asking, since
// only it has checked their session. No answer from here ever holds the key.
//
// The key is kept in the space's folder only encrypted, and what unlocks it
// is kept apart, with the accounts (`lock`): the host hands it to the kernel
// with each request, and the kernel keeps it nowhere.

import { bodyOf } from "./auth/accounts.ts";
import type { RouteRequest, RouteResponse } from "./routes.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The largest request to a model through a space: a conversation with a page's code in it fits. */
const MAX_BYTES = 1_000_000;
/** A model may take minutes to answer. */
export const MODEL_TIMEOUT_MS = 6 * 60_000;

/** What a host gives the routes. */
export interface ModelHost {
  /** Who sent the request, if they are in the space: their id, the name on their account, and their role. */
  member(request: Request, space: string): Promise<{ id: string; name: string; role: "owner" | "editor" | "reader" } | null>;
  /** What unlocks the space's key, kept with the accounts and made the first time it is asked for. */
  lock(space: string): Promise<string>;
  /** Asks the space's kernel at its `model` door. */
  ask(space: string, origin: string, request: RouteRequest): Promise<RouteResponse | null>;
  /** Vendors' hosts the deployment reaches through a gateway of its own (MODEL_GATEWAYS), by host. */
  gateways?: Record<string, string>;
}

/**
 * The deployment's MODEL_GATEWAYS setting: JSON such as {"api.anthropic.com":"https://gateway.example/anthropic"}.
 * Anything else stops the server from starting, rather than quietly reaching the vendor some other way.
 */
export function gatewaysFrom(setting: string | undefined, allowPrivate: string[] = []): Record<string, string> {
  if (!setting?.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(setting);
  } catch {
    throw new Error('MODEL_GATEWAYS must be JSON, such as {"api.anthropic.com":"https://gateway.example/anthropic"}');
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MODEL_GATEWAYS must be a JSON object of vendor host to gateway address");
  const out: Record<string, string> = {};
  for (const [host, to] of Object.entries(value)) {
    let url: URL | undefined;
    try {
      url = new URL(String(to));
    } catch {}
    // Plain http only to a host the deployment already allows as private (local development and the server checks).
    if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && allowPrivate.includes(url.hostname)))) throw new Error(`MODEL_GATEWAYS: ${host} must lead to an https address, not ${String(to)}`);
    out[host] = url.href;
  }
  return out;
}

const ROUTE = /^\/auth\/spaces\/([a-z0-9][a-z0-9-]{0,62})\/model(\/key)?$/;

/** Answers the routes, or gives undefined for any other request. */
export async function modelRoute(request: Request, host: ModelHost): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = ROUTE.exec(url.pathname);
  if (!match) return undefined;
  const [, space, key] = match;
  const { method } = request;
  if (key ? method !== "POST" && method !== "DELETE" : method !== "GET" && method !== "POST") return json({ error: "Method not allowed" }, 405);
  // A page on another site can't spend a space's key, or change it.
  if (method !== "GET" && request.headers.get("origin") !== url.origin) return json({ error: "Not from this site" }, 403);
  const who = await host.member(request, space);
  if (!who) return json({ error: "Only the space's members can use its model. Sign in, or ask its owner for an invite." }, 401);
  if (key && who.role !== "owner") return json({ error: "Only the space's owner can give it a model key, or take it away" }, 403);

  let form: Record<string, unknown>;
  if (method === "GET") form = { op: "state" };
  else if (method === "DELETE") form = { op: "clear" };
  else {
    const text = await bodyOf(request, MAX_BYTES);
    if (text === null) return json({ error: "That is more than a space's model reads at once (1 MB). Ask something shorter." }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "JSON only" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "JSON only" }, 400);
    // (A page's account service only posts, so { remove: true } takes the key away as DELETE does.)
    form = key ? (body.remove === true ? { op: "clear" } : { op: "set", vendor: body.vendor, key: body.key }) : body.models === true ? { op: "models" } : { op: "complete", request: body.request };
  }
  const result = await host
    .ask(space, url.origin, {
      method: "POST",
      path: "/model",
      door: "model",
      member: who.id,
      form: { ...form, name: who.name, owner: who.role === "owner", lock: await host.lock(space), ...(host.gateways && Object.keys(host.gateways).length ? { gateways: host.gateways } : {}) },
    })
    .catch((error: unknown) => ({ status: 502, json: { error: `The space's server didn't answer: ${error instanceof Error ? error.message : String(error)}` } }) as RouteResponse);
  if (!result) return json({ error: "This site's spaces can't hold a model key (its kernel has no spaces module)" }, 501);
  return json(result.json ?? { error: result.text ?? "The space's server gave no answer" }, result.status ?? 200);
}
