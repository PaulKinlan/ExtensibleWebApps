// An app is a folder with an app.html. A visit to the folder itself
// (/demos/habits/) gets that page, so an app's address doesn't need the file
// name. So does a visit to a screen inside it (/demos/reading-list/book/42):
// the nearest folder up with an app.html answers, and the router service
// tells the app's plugins which screen it is (std/router/module.ts).
//
// The page gets a <base> naming the app's folder, so its relative links
// (library.js, book/42) resolve as they do at /demos/reading-list/app.html,
// whichever screen it was opened at. An address whose last part has a dot
// (books.json, app.html) is a file, and goes to the network as usual, as does
// any address with no app above it.

/** How many folders up a screen may be from its app: /demos/reading-list/a/b/c/d/e/f is the deepest. */
const DEPTH = 8;

/**
 * The folders an address could belong to, nearest first: /demos/reading-list/book/42 → /demos/reading-list/book/42/,
 * …/book/, /demos/reading-list/, /demos/, and last the site's root, where a project's one app lives
 * (/book/42 → /book/42/, /book/, /: scripts/extensible-app.mjs).
 */
function folders(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  const out = [];
  for (let n = parts.length; n > 0 && out.length < DEPTH; n--) out.push(`/${parts.slice(0, n).join("/")}/`);
  if (parts.length <= DEPTH) out.push("/");
  return out;
}

export default {
  name: "apps",
  /** @param {Request} request @param {URL} url @param {{ fetch(r: Request | string): Promise<Response> }} env */
  async handle(request, url, env) {
    if (request.mode !== "navigate" || request.method !== "GET" || url.pathname === "/") return undefined;
    if (url.pathname.split("/").pop().includes(".")) return undefined;
    // The site's front page, to tell an app.html from a server's fallback page: asked for alongside the first folder, not after it.
    const front = env.fetch(new Request(new URL("/index.html", url))).then((r) => (r.ok ? r.text() : ""), () => "");
    for (const folder of folders(url.pathname)) {
      const page = await env.fetch(new Request(new URL(`${folder}app.html`, url))).catch(() => undefined);
      if (!page?.ok || !(page.headers.get("Content-Type") ?? "").includes("text/html")) continue;
      // A server may answer a missing file with its front page (a single-page fallback, or the
      // development server's index). That isn't this folder's app: try the next folder up.
      // An app.html only has to load the platform; it needn't link any plugins.
      const html = await page.text();
      if (!/<script\b[^>]*\bsrc=["']?\/platform\/host\.js/i.test(html) || html.includes("/@vite/client")) continue;
      if (folder !== "/" && html === (await front)) continue;
      // An address the server has a page for (/account/, /auth/…) is that page, not a screen of an app at the root.
      if (folder === "/") {
        const itself = await env.fetch(request).catch(() => undefined);
        if (itself?.ok) return itself;
      }
      // At the root the front page is the app's own page (a copy of /app.html), so that can't tell them apart:
      // instead, a server that answers an address it has no file for with a page isn't serving an app.html here.
      if (folder === "/" && (await env.fetch(new Request(new URL("/no-such-file-here.html", url))).then((r) => r.ok, () => false))) continue;
      // The server's headers (its security policies, caching) stay; only those about the encoded body go, as it's decoded here.
      const headers = new Headers(page.headers);
      headers.delete("Content-Encoding");
      headers.delete("Content-Length");
      const based = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (head) => `${head}\n  <base href="${folder}">`) : `<base href="${folder}">${html}`;
      return new Response(based, { status: 200, headers });
    }
    return undefined;
  },
};
