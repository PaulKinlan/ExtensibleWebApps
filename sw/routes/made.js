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

const text = (body, status) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export default {
  name: "made",
  prefix: "/apps/",
  /**
   * @param {Pick<Request, "method" | "mode">} request @param {URL} url @param {unknown} [_env]
   * @param {string[]} [within] the folder the data is in: an app made in a space is kept under spaces/<space>/
   */
  async handle(request, url, _env, within = []) {
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
