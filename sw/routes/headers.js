// Puts the plugin-worker security policy on the scripts plugin workers run, on
// any host. Plugin workers get their policy from the response that serves
// their script: no scripts but their own, no workers of their own, and no
// network unless the plugin has the `network` permission. The development
// server (vite.config.ts) and Cloudflare (public/_headers) already send it;
// this makes the rule travel with the platform to any other host. The two
// policies must stay the same as vite.config.ts.

const WORKER_CSP = "default-src 'none'; script-src 'self' blob:; worker-src 'none'; connect-src 'none'";
const NETWORK_WORKER_CSP = "default-src 'none'; script-src 'self' blob:; worker-src 'none'; connect-src 'self' https: wss:";

export default {
  name: "headers",
  /** @param {Request} request @param {URL} url @param {{ fetch(r: Request): Promise<Response> }} env */
  async handle(request, url, env) {
    const policy = /\/net-runtime(\.ts|-[\w-]+\.js)$/.test(url.pathname) ? NETWORK_WORKER_CSP : /\/runtime(\.ts|-[\w-]+\.js)$/.test(url.pathname) ? WORKER_CSP : undefined;
    if (!policy || request.method !== "GET") return undefined;
    const response = await env.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", policy);
    // The body is already decoded here.
    headers.delete("Content-Encoding");
    headers.delete("Content-Length");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
