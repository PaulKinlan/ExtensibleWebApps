import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Plugin workers get their content security policy from the response that
// serves their script. No plugin may load scripts other than its own module
// (a blob: URL), none may start workers of its own (which would get their own
// policy), and only plugins with the `network` permission may connect out.
export const WORKER_CSP = "default-src 'none'; script-src 'self' blob:; worker-src 'none'; connect-src 'none'";
export const NETWORK_WORKER_CSP = "default-src 'none'; script-src 'self' blob:; worker-src 'none'; connect-src 'self' https: wss:";

function workerPolicy(): Plugin {
  const header = (url = ""): string | undefined => {
    if (/\/net-runtime(\.ts|-[\w-]+\.js)/.test(url)) return NETWORK_WORKER_CSP;
    if (/\/runtime(\.ts|-[\w-]+\.js)/.test(url)) return WORKER_CSP;
    return undefined;
  };
  const middleware = (req: { url?: string }, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    const policy = header(req.url);
    if (policy) res.setHeader("Content-Security-Policy", policy);
    next();
  };
  return {
    name: "worker-policy",
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

// Files the browser runs as written: served untouched in development (no
// transforms, no injected scripts) and copied unchanged into the build.
// That is every top-level folder except the ones below, and every .html or
// .js file at the top. Nothing lists them, so a change that adds a folder
// (a new app area, the service worker) doesn't edit this file.
//
// site/ is this website's own pages (the front page, the homepage chapters,
// the workbench), kept apart so the top of the repo is the platform. What is
// in it is served at the site's root, as if it were at the top: site/home/ is
// /home/ and site/index.html is /.
const NOT_SERVED = [
  "dist",
  "node_modules",
  "public", // Vite copies it itself
  "scripts",
  "site", // served at the root, below
  "src", // built
  "tests",
];
const SITE = "site";
/** Each file or folder served as written: `url` is its name at the site's root, `disk` where it is in the repo. */
const asWrittenEntries = (root: string): { url: string; disk: string }[] => {
  const list = (dir: string, skip: string[]) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .filter((e) => (e.isDirectory() ? !skip.includes(e.name) : e.isFile() && /\.(html|js)$/.test(e.name)))
      .map((e) => ({ url: e.name, disk: dir ? `${dir}/${e.name}` : e.name }));
  const entries = [...list("", NOT_SERVED), ...(existsSync(join(root, SITE)) ? list(SITE, []) : [])];
  const twice = entries.map((e) => e.url).filter((url, i, all) => all.indexOf(url) !== i);
  if (twice.length) throw new Error(`site/ and the top of the repo both have ${twice.join(", ")}: one address, one file`);
  return entries.sort((a, b) => a.url.localeCompare(b.url));
};
// Two stable URLs every page uses: the platform's stylesheet and its host
// script. In development the script redirects to the TypeScript source (so
// its relative worker URLs resolve); in the build it is emitted at this path.
const HOST_CSS = "src/host/styles.css";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".md": "text/markdown", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };

function asWritten(): Plugin {
  const root = process.cwd();
  const files = (path: string): string[] =>
    statSync(join(root, path)).isDirectory() ? readdirSync(join(root, path)).flatMap((name) => files(join(path, name))) : [path];
  const serve = (res: { setHeader(k: string, v: string): void }, file: string) => {
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    return createReadStream(file).pipe(res as any);
  };
  return {
    name: "as-written",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent(new URL(req.url ?? "/", "http://host").pathname);
        if (path === "/platform/host.js") {
          res.statusCode = 302;
          res.setHeader("Location", "/src/host/main.ts");
          return res.end();
        }
        if (path === "/platform/host.css") return serve(res, resolve(root, HOST_CSS));
        // site/ is served at the root, never under /site/, as in the build.
        if (path === `/${SITE}` || path.startsWith(`/${SITE}/`)) {
          res.statusCode = 404;
          return res.end();
        }
        const entries = asWrittenEntries(root);
        // A top-level file is served only by its exact name ("/" is index.html); a folder serves what is inside it.
        const name = path === "/" ? "index.html" : path.slice(1);
        const exact = entries.find((e) => e.url === name);
        if (exact && statSync(join(root, exact.disk)).isFile()) return serve(res, resolve(root, exact.disk));
        const top = entries.find((e) => statSync(join(root, e.disk)).isDirectory() && path.startsWith(`/${e.url}/`));
        if (!top) return next();
        // A folder's address serves its index.html, as Vite (and Cloudflare) do for the folders at the top.
        const file = resolve(root, top.disk, `.${path.slice(top.url.length + 1)}${path.endsWith("/") ? "index.html" : ""}`);
        if (!file.startsWith(resolve(root, top.disk) + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        return serve(res, file);
      });
    },
    generateBundle() {
      for (const { url, disk } of asWrittenEntries(root))
        for (const file of files(disk)) this.emitFile({ type: "asset", fileName: url + file.slice(disk.length).split(sep).join("/"), source: readFileSync(join(root, file)) });
      this.emitFile({ type: "asset", fileName: "platform/host.css", source: readFileSync(join(root, HOST_CSS)) });
    },
  };
}

// An address with no file gets 404.html with a 404, as Cloudflare's
// `not_found_handling: "404-page"` does (wrangler.jsonc), rather than Vite's
// index.html fallback. 404.html starts the service worker, which answers an
// app's screens (/demos/reading-list/book/42) with the app's page.
function notFoundPage(): Plugin {
  const handler = (root: string, page: string) => (req: { url?: string; method?: string; headers: Record<string, string | string[] | undefined> }, res: any, next: () => void) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://host").pathname);
    const navigating = req.method === "GET" && String(req.headers.accept ?? "").includes("text/html");
    // In development a page may be in site/ (served at the root); the build has it at the root already.
    const exists = [root, join(root, SITE)].some((base) => {
      const file = resolve(base, `.${path}`);
      return file.startsWith(base) && existsSync(file) && (statSync(file).isFile() || existsSync(join(file, "index.html")));
    });
    if (!navigating || exists || path.split("/").pop()!.includes(".") || path.startsWith("/@") || path.startsWith("/src/") || path.startsWith("/node_modules/")) return next();
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/html");
    return createReadStream(page).pipe(res);
  };
  return {
    name: "not-found-page",
    configureServer: (server) => void server.middlewares.use(handler(process.cwd(), resolve("public/404.html"))),
    configurePreviewServer: (server) => void server.middlewares.use(handler(resolve("dist"), resolve("dist/404.html"))),
  };
}

export default defineConfig({
  plugins: [workerPolicy(), asWritten(), notFoundPage()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    // The host is the one entry: /platform/host.js, which every page loads. Pages themselves are copied as written.
    rollupOptions: { input: { host: "src/host/main.ts" }, output: { entryFileNames: "platform/[name].js" } },
  },
});
