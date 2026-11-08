// A space is data people share, and any app can open in it: /s/family/demos/reading-list/
// is the reading list, in the family space. Its files are the app's own, so an address
// inside a space is answered with the same address outside it, and a page gets a
// <base> inside the space, so its links and screens stay there. The page then starts
// a kernel of the space's own, which keeps a copy of its data and syncs with it
// (src/host/main.ts, src/kernel/sync-device.ts).
//
// /s/<space>/kernel is the space's kernel itself, on the server: it goes to the network.

import apps from "./apps.js";
import user from "./user.js";

const SPACE = /^\/s\/([a-z0-9][a-z0-9-]{0,62})(\/.*)$/;

/**
 * The space's server's answer to a page, if one of its plugins gave it (src/server/routes.ts marks it with
 * X-Space-Route); undefined when the server only has the site's files there, or can't be reached.
 * @param {Request} request
 */
async function fromServer(request) {
  const response = await fetch(request).catch(() => undefined);
  // A route's redirect, once it has run (after a form is sent): a navigation's redirect can't be read, only followed.
  if (response?.type === "opaqueredirect" || response?.headers.has("X-Space-Route")) return response;
  return undefined;
}

/**
 * Whether an address is an app's own folder: it ends in / and has an app.html. A route may end in / too.
 * @param {URL} url @param {{ fetch(r: Request | string): Promise<Response> }} env
 */
async function isApp(url, env) {
  if (!url.pathname.endsWith("/")) return false;
  const page = await env.fetch(new Request(new URL("app.html", url))).catch(() => undefined);
  return !!page?.ok && (page.headers.get("Content-Type") ?? "").includes("text/html");
}

export default {
  name: "spaces",
  prefix: "/s/",
  /** @param {Request} request @param {URL} url @param {{ fetch(r: Request | string): Promise<Response> }} env */
  async handle(request, url, env) {
    const match = SPACE.exec(url.pathname);
    if (!match || request.method !== "GET" || match[2] === "/kernel") return undefined;
    const [, space, path] = match;
    // The same site, at the path inside the space: set as a path, so `//elsewhere/…` can't name another site.
    if (path.startsWith("//")) return new Response("Not found", { status: 404 });
    const inner = new URL(url);
    inner.pathname = path;
    // The plugins a person added to an app in the space are kept in the space's folder on this device.
    if (path.startsWith("/user/")) return user.handle(request, inner, env, ["spaces", space]);
    if (request.mode === "navigate") {
      // A plugin on the space's server may answer this address, for anyone: a survey's form at
      // …/demos/survey/answer?survey=…. The server says so, and its answer is the page. An app's own
      // folder (one with an app.html, from the cache) is never asked, so opening an app costs no extra trip.
      const routed = (await isApp(inner, env)) ? undefined : await fromServer(request);
      if (routed) return routed;
      // The app's page, as apps.js serves it outside the space, with its <base> moved inside.
      const page = await apps.handle({ mode: "navigate", method: "GET" }, inner, env);
      if (page) {
        const html = (await page.text()).replace(/<base href="\//, `<base href="/s/${space}/`);
        return new Response(html, { status: page.status, headers: page.headers });
      }
    }
    // A file (a plugin, a template, app.html itself): the app's own. Relative links from a page
    // opened as a file already resolve inside the space.
    const file = await env.fetch(new Request(inner));
    return new Response(file.body, { status: file.status, statusText: file.statusText, headers: file.headers });
  },
};
