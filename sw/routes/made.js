// Apps a person made in the browser (std/maker/), served from their data
// folder on this device: /apps/reading-list/ is the page made/apps/
// reading-list/app.html there, and /apps/reading-list/library.js its plugin.
// They never touch the server, like the plugins a person adds (user.js).
//
// A made app's page was written by a model, so it is checked again here
// before it is served (sw/made-page.js: no script but the
// platform's, no frames, no handlers) and sent with a policy that runs no
// script but this site's own files. Its code is its plugins, which run in
// workers with only the permissions they ask for, like any app's.
//
// In a space, /s/family/apps/reading-list/ is the app made (or accepted from
// the space's members) in that space, kept in the space's folder on this
// device (sw/routes/spaces.js passes `within`).
//
// Like apps.js, a visit to a screen inside the app (/apps/reading-list/book/
// 42) gets the app's page, with a <base> naming its folder.

import { APP_NAME, FILE_NAME, PAGE_CSP, PERMISSIONS_POLICY, pageProblems } from "../made-page.js";
import { hintsFor } from "../preload-hints.js";

const TYPES = { js: "text/javascript", html: "text/html", css: "text/css", md: "text/markdown" };

/** A file of a made app, or undefined. @param {string} app @param {string} file @param {string[]} within */
async function read(app, file, within) {
  try {
    let folder = await navigator.storage.getDirectory();
    for (const part of [...within, "made", "apps", app]) folder = await folder.getDirectoryHandle(part);
    return await (await folder.getFileHandle(file)).getFile();
  } catch {
    return undefined;
  }
}

/**
 * Starts fetching, and so keeping, the platform's files a made app's first view needs (sw/preload-hints.js): the
 * elements its templates use, their scripts, the kernel modules its plugins name. The build writes these into the
 * site's own app pages as preload hints; a made app's page is served here, where the worker can ask for them
 * itself as it answers the page, without changing a line of it. The app's own files are on this device already,
 * so only an element or a module this device has never used is a round trip saved, and the page never waits.
 * @param {string} html @param {string} folder the app's address @param {string} app @param {string[]} within
 * @param {{ fetch?(r: Request | string): Promise<Response> } | undefined} env
 */
async function warm(html, folder, app, within, env) {
  if (typeof env?.fetch !== "function") return;
  const site = (/** @type {string} */ path) => env.fetch(new Request(new URL(path, self.location.href))).then((r) => (r.ok ? r.text() : undefined), () => undefined);
  const mine = (/** @type {string} */ path) => {
    const name = path.startsWith(folder) ? path.slice(folder.length) : "";
    return name && FILE_NAME.test(name) ? read(app, name, within).then((file) => file?.text()) : site(path);
  };
  try {
    const known = await site("/platform/preload.json");
    // Reading each file to find the next is what fetches and keeps it; a script, which isn't read, is asked for here.
    for (const { href, as } of await hintsFor(html, `${folder}app.html`, mine, known ? JSON.parse(known) : {})) if (as === "module") void site(href);
  } catch {
    // A head start only: the page asks for each file itself.
  }
}

const text = (body, status) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export default {
  name: "made",
  prefix: "/apps/",
  /**
   * @param {Pick<Request, "method" | "mode">} request @param {URL} url @param {{ fetch?(r: Request | string): Promise<Response>; wait?(work: Promise<unknown>): void }} [env]
   * @param {string[]} [within] the folder the data is in: an app made in a space is kept under spaces/<space>/
   */
  async handle(request, url, env, within = []) {
    if (request.method !== "GET" && request.method !== "HEAD") return undefined;
    const [, , app, ...rest] = decodeURIComponent(url.pathname).split("/");
    if (!app || !APP_NAME.test(app)) return undefined;
    const last = rest.at(-1) ?? "";
    if (request.mode === "navigate" || last === "" || last === "app.html" || !last.includes(".")) {
      const file = await read(app, "app.html", within);
      const inSpace = within[0] === "spaces" ? `/s/${within[1]}` : "";
      if (!file) return text(`There's no app called ${app} on this device. Make one at ${inSpace}/new/.`, 404);
      const html = await file.text();
      const problems = pageProblems(html);
      if (problems.length) return text(`This app's page breaks the rules for made apps, so it isn't shown:\n\n${problems.map((p) => `line ${p.line}: ${p.message}`).join("\n")}`, 500);
      const folder = `${inSpace}/apps/${app}/`;
      const warming = warm(html, folder, app, within, env);
      if (typeof env?.wait === "function") env.wait(warming);
      const based = html.replace(/<head\b[^>]*>/i, (head) => `${head}\n  <base href="${folder}">`);
      return new Response(based.includes(`<base href="${folder}">`) ? based : `<base href="${folder}">${html}`, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PAGE_CSP, "Permissions-Policy": PERMISSIONS_POLICY, "X-Content-Type-Options": "nosniff" },
      });
    }
    // A file the page loads: one of the app's plugins, templates or styles.
    if (rest.length !== 1 || !FILE_NAME.test(last)) return text("Not found", 404);
    const file = await read(app, last, within);
    if (!file) return text("Not found", 404);
    const type = TYPES[/** @type {keyof typeof TYPES} */ (last.split(".").pop() ?? "")] ?? "application/octet-stream";
    return new Response(file, {
      headers: {
        "Content-Type": type,
        "Cache-Control": "no-store",
        // Never a live page on its own: the host reads templates and plugin code with fetch, which this doesn't touch.
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
};
