// A space's public routes, on either host: an HTTP request to
// /s/<space>/<path> that a server plugin answers, as a route it added with
// ctx.routes.add (src/kernel/routes.ts). In a browser the service worker
// answers a route from the tab's kernel (sw/routes/plugins.js); a server
// plugin's routes are answered here, by the space's kernel, so a form on
// another site or a webhook can reach the space with no one's browser open.
//
// They are public: anyone may call them, signed in or not, and the plugin
// isn't told who. A request with no route behind it is the host's to answer
// as before (the site's files).
//
// The space's prefix is taken off the path, so a plugin at
// /survey/survey.js answers /s/<space>/survey/answer as "POST /survey/answer".

/** What the kernel is asked (src/kernel/routes.ts has the same shapes; the server doesn't import the kernel). */
export interface RouteRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  form?: unknown;
}

/** What a plugin's route answers. */
export interface RouteResponse {
  status?: number;
  redirect?: string;
  html?: string;
  json?: unknown;
  text?: string;
}

/** The largest body a route reads. */
const MAX_BODY = 64 * 1024;

/** A request to a space's address that isn't its kernel's socket: the space and the path inside it. */
export function spaceRoute(url: URL): { space: string; path: string } | undefined {
  const match = /^\/s\/([^/]+)(\/.+)$/.exec(url.pathname);
  if (!match || match[2] === "/kernel") return undefined;
  return { space: match[1], path: match[2] };
}

/** The request as plain values for the kernel: a form's fields or a JSON body, within size. Null if too big. */
export async function routeRequest(request: Request, path: string): Promise<RouteRequest | null> {
  const url = new URL(request.url);
  // HEAD stays HEAD: the kernel answers it with a HEAD route if a plugin has one, else with its GET route.
  const out: RouteRequest = { method: request.method, path, query: Object.fromEntries(url.searchParams) };
  if (request.method === "GET" || request.method === "HEAD") return out;
  const body = await readBody(request);
  if (body === null) return null;
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      out.form = JSON.parse(new TextDecoder().decode(body));
    } catch {}
  } else if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    // Read as a browser's form is (sw/routes/plugins.js): string fields, repeated ones as a list, files left out.
    const data = await new Response(body, { headers: { "content-type": type } }).formData().catch(() => undefined);
    if (data) {
      const fields = new Map<string, string | string[]>();
      for (const [name, value] of data) {
        if (typeof value !== "string") continue;
        const had = fields.get(name);
        fields.set(name, had === undefined ? value : ([] as string[]).concat(had, value));
      }
      // fromEntries defines each field as the object's own, so one named __proto__ is just a field. (A plain
      // object, not one without a prototype, which Cloudflare's RPC can't send.)
      out.form = Object.fromEntries(fields);
    }
  }
  return out;
}

async function readBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) all.set(chunk, (at += chunk.length) - chunk.length);
  return all;
}

// A page a plugin returns may show forms and links, but runs no script and loads nothing from elsewhere (as sw/routes/plugins.js).
const PAGE_CSP = "sandbox allow-forms allow-same-origin; default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'";

/**
 * The plugin's answer as an HTTP response, as the service worker gives it. A route's answer as a response, marked with `X-Space-Route`: the service worker, which otherwise answers an
 * address inside a space with the app's page, passes a marked answer on as it is (sw/routes/spaces.js).
 */
export function routeResponse(result: RouteResponse, url: URL, space: string): Response {
  const response = answer(result, url, space);
  response.headers.set(ROUTED, "1");
  return response;
}

/** The header that says a response is a space's route's answer, not the site's files. */
export const ROUTED = "X-Space-Route";

/** The plugin's answer as an HTTP response. */
function answer(result: RouteResponse, url: URL, space: string): Response {
  const status = Number.isInteger(result.status) && result.status! >= 200 && result.status! < 600 ? result.status! : 200;
  if (status === 204 || status === 205 || status === 304) return new Response(null, { status });
  if (typeof result.redirect === "string") {
    const to = new URL(result.redirect, url);
    if (to.origin !== url.origin) return new Response("A plugin can only send people to a page on this site", { status: 500 });
    // A plugin in a space sends people to a page in the same space.
    if (!to.pathname.startsWith(`/s/${space}/`)) to.pathname = `/s/${space}${to.pathname}`;
    return new Response(null, { status: 303, headers: { location: to.href } });
  }
  if (typeof result.html === "string") return new Response(result.html, { status, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_CSP } });
  if ("json" in result) return new Response(JSON.stringify(result.json), { status, headers: { "content-type": "application/json" } });
  return new Response(String(result.text ?? ""), { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export const tooLarge = () => new Response("That's more than a route reads", { status: 413 });
