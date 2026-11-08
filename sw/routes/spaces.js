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
