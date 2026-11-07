// The plugins a person added to an app themselves, and the files they
// brought, served from the data folder on this device: /user/demos/trip/
// countdown.html is the file user/demos/trip/countdown.html there. They
// never touch the server, so a plugin's templates and images load like any
// other file and the app's own files stay as the author wrote them.
//
// The data folder is the origin private file system, which a service worker
// can read itself, so this works with no tab awake. (When the platform lets
// a person pick a real folder instead, the tab will have to read it:
// env.kernel, through an open tab.)

const TYPES = {
  js: "text/javascript",
  html: "text/html",
  css: "text/css",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export default {
  name: "user",
  prefix: "/user/",
  /** @param {Request} request @param {URL} url */
  async handle(request, url) {
    if (request.method !== "GET") return undefined;
    const parts = decodeURIComponent(url.pathname).split("/").slice(1);
    // The same rules the kernel uses for app folders and file names: no dots that climb, nothing hidden.
    if (parts.some((p) => !p || p.startsWith(".") || !/^[\w.-]+$/.test(p))) return new Response("Not found", { status: 404 });
    try {
      let folder = await navigator.storage.getDirectory();
      for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part);
      const file = await (await folder.getFileHandle(parts.at(-1))).getFile();
      const type = TYPES[/** @type {keyof typeof TYPES} */ (parts.at(-1).split(".").pop()?.toLowerCase() ?? "")] ?? "application/octet-stream";
      // Never cached: the person may change or remove it at any moment. And never a live page: a
      // template or an SVG opened on its own would otherwise run its scripts as this site, outside any
      // worker and its permissions. The host reads templates with fetch, which this doesn't touch.
      return new Response(file, {
        headers: {
          "Content-Type": type,
          "Cache-Control": "no-store",
          "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
};
