// Plugins answer requests. A plugin an app links can add routes inside its own
// folder with ctx.routes.add(method, path, handler), so a plain link or form
// reaches it:
//
//   ctx.routes.add("GET", "books.json", () => ({ json: books }));
//   <form method="post" action="snooze">  →  ctx.routes.add("POST", "snooze", …)
//
// The kernel keeps the table of routes the running plugins added, and shares
// it through the cache and a broadcast. Only a request in the table is sent to
// the kernel, so every other request goes on to the network with no delay.
//
// What a handler returns becomes the response: { redirect } (a 303 to a page
// on this site), { html } (a page in which no script runs), { json }, or
// { text }, each with an optional status. Nothing means no plugin answered: 404.

const TABLE = new Request("/routes.json");

/** "GET /demos/reading-list/books.json", for each route a running plugin added. */
let table = null;
new BroadcastChannel("platform:routes").onmessage = (e) => (table = new Set(e.data));

async function routes() {
  if (table) return table;
  const kept = await (await caches.open("platform-routes")).match(TABLE);
  table = new Set(kept ? await kept.json() : []);
  return table;
}

// A page a plugin returns may show forms and links, but runs no script and loads nothing from elsewhere.
const PAGE_CSP = "sandbox allow-forms allow-same-origin; default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'";

export default {
  name: "plugins",
  /** @param {Request} request @param {URL} url @param {{ kernel(name: string, arg: unknown): Promise<any> }} env */
  async handle(request, url, env) {
    const key = `${request.method} ${url.pathname}`;
    if (!(await routes()).has(key)) return undefined;
    const form = request.method === "GET" || request.method === "HEAD" ? undefined : await fields(request);
    let result;
    try {
      result = await env.kernel("route", { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), form });
    } catch (error) {
      return new Response(`Open the app to use this: ${error instanceof Error ? error.message : error}`, { status: 503 });
    }
    return respond(result, url);
  },
};

/** A form's fields, or a JSON body, as plain values. Files are left out. @param {Request} request */
async function fields(request) {
  const type = request.headers.get("Content-Type") ?? "";
  if (type.includes("application/json")) return request.json().catch(() => undefined);
  if (!type.includes("form")) return undefined;
  const data = await request.formData();
  const out = {};
  for (const [name, value] of data) if (typeof value === "string") out[name] = name in out ? [].concat(out[name], value) : value;
  return out;
}

/** @param {any} result @param {URL} url */
function respond(result, url) {
  if (!result || typeof result !== "object") return new Response("No plugin answered", { status: 404 });
  const status = Number.isInteger(result.status) && result.status >= 200 && result.status < 600 ? result.status : 200;
  if (typeof result.redirect === "string") {
    const to = new URL(result.redirect, url);
    if (to.origin !== url.origin) return new Response("A plugin can only send people to a page on this site", { status: 500 });
    return new Response(null, { status: 303, headers: { Location: to.href } });
  }
  if (typeof result.html === "string") return new Response(result.html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP } });
  if ("json" in result) return new Response(JSON.stringify(result.json), { status, headers: { "Content-Type": "application/json" } });
  return new Response(String(result.text ?? ""), { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
