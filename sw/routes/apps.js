// An app is a folder with an app.html. A visit to the folder itself
// (/demos/habits/) gets that page, so an app's address doesn't need the file
// name. The address stays the folder's, so the page's relative links resolve
// as they do at /demos/habits/app.html. A folder without an app.html goes to
// the network as usual.

export default {
  name: "apps",
  /** @param {Request} request @param {URL} url @param {{ fetch(r: Request | string): Promise<Response> }} env */
  async handle(request, url, env) {
    if (request.mode !== "navigate" || request.method !== "GET" || url.pathname === "/" || !url.pathname.endsWith("/")) return undefined;
    const page = await env.fetch(new Request(new URL("app.html", url))).catch(() => undefined);
    if (!page?.ok || !(page.headers.get("Content-Type") ?? "").includes("text/html")) return undefined;
    // A development server answers a missing file with its index page: an app.html links plugins.
    const html = await page.text();
    if (!/<link\b[^>]*\brel=["']?plugin\b/i.test(html)) return undefined;
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};
