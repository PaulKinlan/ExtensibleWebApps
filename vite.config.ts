import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { type Duplex, Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { frontDoor } from "./src/server/front-door";
import { createLiveMcpRelay } from "./src/server/live-mcp";
import { accept } from "./src/server/websocket";
import { kernelModules } from "./vite.kernel-modules";
import { onDemandParts } from "./vite.parts";
import { siteHeaders } from "./vite.site-headers";
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

// Files made from other files (scripts/generated.mjs): the plugin registry and the demo gallery's lists.
// They are never committed, so they never conflict: made here as they are served in development, and
// written into the build. Loaded when first needed, as plain Node (it reads the repo, it isn't bundled).
type Generated = { PATHS: string[]; generated(): Promise<Record<string, string>> };
let generatedModule: Promise<Generated> | undefined;
const generatedFiles = (root: string) => (generatedModule ??= import(pathToFileURL(join(root, "scripts/generated.mjs")).href));

/** A kernel module's source, std/<name>/module.ts: built into the kernel, never served as a file. */
const KERNEL_MODULE = /^\/std\/[a-z][a-z0-9-]*\/module\.ts$/;

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
      // A generated file, made now from what is on disk (a folder's address is its index.html). Anything else
      // goes on to be served as written, below.
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent(new URL(req.url ?? "/", "http://host").pathname);
        const wanted = path.slice(1) + (path.endsWith("/") ? "index.html" : "");
        if (!/^(demos|packages)\//.test(wanted)) return next();
        generatedFiles(root)
          .then(async ({ PATHS, generated }) => {
            if (!PATHS.includes(wanted)) return next();
            const text = (await generated())[wanted];
            res.setHeader("Content-Type", TYPES[extname(wanted)] ?? "application/octet-stream");
            res.end(text);
          })
          .catch((error) => next(error));
      });
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
        // A folder of site/ named without its slash (/workbench) goes to its address with one, as Vite does for the others.
        const folder = entries.find((e) => e.disk.startsWith(`${SITE}/`) && path === `/${e.url}` && statSync(join(root, e.disk)).isDirectory());
        if (folder) {
          res.statusCode = 301;
          res.setHeader("Location", `/${folder.url}/${new URL(req.url ?? "/", "http://host").search}`);
          return res.end();
        }
        // A kernel module is TypeScript the kernel imports (vite.kernel-modules.ts): Vite compiles it, it isn't served as written.
        if (KERNEL_MODULE.test(path)) return next();
        const top = entries.find((e) => statSync(join(root, e.disk)).isDirectory() && path.startsWith(`/${e.url}/`));
        if (!top) return next();
        // A folder's address serves its index.html, as Vite (and Cloudflare) do for the folders at the top.
        const file = resolve(root, top.disk, `.${path.slice(top.url.length + 1)}${path.endsWith("/") ? "index.html" : ""}`);
        if (!file.startsWith(resolve(root, top.disk) + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        return serve(res, file);
      });
    },
    async generateBundle() {
      // The generated files, made from the repo as it is now. A copy left on disk from before they were
      // generated is skipped: what is built is always what the manifests say.
      const { generated } = await generatedFiles(root);
      const made = await generated();
      for (const { url, disk } of asWrittenEntries(root))
        for (const file of files(disk)) {
          const fileName = url + file.slice(disk.length).split(sep).join("/");
          if (!KERNEL_MODULE.test(`/${file.split(sep).join("/")}`) && !(fileName in made)) this.emitFile({ type: "asset", fileName, source: readFileSync(join(root, file)) });
        }
      for (const [fileName, source] of Object.entries(made)) this.emitFile({ type: "asset", fileName, source });
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

// Live MCP relay in development and preview, matching Node (src/server/serve.ts) and Cloudflare (worker.ts):
// an open browser tab connects /mcp/live/<channel>/bridge and shares /mcp/live/<channel>/<token> with an MCP client.
function liveMcpDev(): Plugin {
  const noAccounts = { exists: async () => false, member: async () => null };
  const attach = (server: { middlewares: { use(fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void }; httpServer: { on(event: "upgrade", fn: (req: IncomingMessage, raw: Duplex) => void): void } | null }) => {
    const relay = createLiveMcpRelay();
    server.httpServer?.on("upgrade", async (req, raw) => {
      if (!req.url?.startsWith("/mcp/live/")) return;
      let where: URL;
      try {
        where = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      } catch {
        return void raw.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      }
      const decision = await frontDoor({ method: req.method ?? "GET", url: where, origin: typeof req.headers.origin === "string" ? req.headers.origin : null, cookie: "", upgrade: true }, noAccounts);
      if (decision.door !== "live-bridge") {
        const status = decision.door === "refuse" ? decision.status : 404;
        return void raw.end(`HTTP/1.1 ${status} Refused\r\n\r\n`);
      }
      const socket = accept(req, raw);
      if (!socket) return;
      const bridge = relay.attach(decision.channel, socket);
      raw.on("close", () => bridge.close());
      socket.onMessage = (text) => bridge.message(text);
      socket.onClose = () => bridge.close();
    });
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith("/mcp/live/")) return next();
      let url: URL;
      try {
        url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const decision = await frontDoor({ method: req.method ?? "GET", url, origin: typeof req.headers.origin === "string" ? req.headers.origin : null, cookie: "", upgrade: false }, noAccounts);
      if (decision.door === "refuse") {
        res.writeHead(decision.status, { "content-type": "text/plain; charset=utf-8" }).end(decision.text);
        return;
      }
      if (decision.door !== "live-mcp") return next();
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream<Uint8Array>);
      const out = await relay.handle(new Request(url, { method: req.method, headers, body, duplex: "half" } as RequestInit), decision.channel, decision.token);
      if (!req.complete) out.headers.set("connection", "close");
      res.writeHead(out.status, Object.fromEntries(out.headers));
      if (!out.body || out.headers.get("content-type") !== "text/event-stream") {
        res.end(Buffer.from(await out.arrayBuffer()));
        return;
      }
      res.flushHeaders();
      const reader = out.body.getReader();
      res.on("close", () => void reader.cancel().catch(() => {}));
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        res.write(value);
      }
      res.end();
    });
  };
  return {
    name: "live-mcp-dev",
    configureServer: (server) => attach(server as any),
    configurePreviewServer: (server) => attach(server as any),
  };
}

export default defineConfig({
  // The kernel's modules: in the worker build, and in development, where Vite serves the kernel through this pipeline.
  plugins: [kernelModules({ split: true }), workerPolicy(), siteHeaders(), liveMcpDev(), asWritten(), notFoundPage(), onDemandParts()],
  // The kernel is a worker: its modules are the ones kernel.json lists, each a file of its own it fetches when first used.
  worker: {
    format: "es",
    plugins: () => [kernelModules({ split: true })],
    // A module's file says which it is: /assets/kernel-router-<hash>.js.
    rollupOptions: { output: { chunkFileNames: (chunk) => `assets/${/\/std\/([a-z][a-z0-9-]*)\/module\.ts$/.exec(chunk.facadeModuleId ?? (chunk.name === "module" ? chunk.moduleIds.find((id) => id.endsWith("/module.ts")) : undefined) ?? "")?.[1]?.replace(/^/, "kernel-") ?? "[name]"}-[hash].js` } },
  },
  build: {
    target: "es2022",
    // The host is the one entry: /platform/host.js, which every page loads. Pages themselves are copied as written.
    // SVG and canvas in views is a file the host loads only when a view has one (src/host/drawing-gate.ts), named for
    // its content. /platform/drawing.js, the fixed address it had, is still built (src/host/drawing-stable.ts) for pages opened before a deploy.
    // What the host and the parts it fetches later both use (the router's helpers, Vite's own loader) stays inside
    // host.js (manualChunks): as files of their own they were three requests every page made after host.js had
    // arrived and before it could run, a round trip on every first visit for 1.4 KB (scripts/first-draw.mjs).
    rollupOptions: { input: { host: "src/host/main.ts", drawing: "src/host/drawing-stable.ts" }, preserveEntrySignatures: "exports-only", output: { entryFileNames: "platform/[name].js", manualChunks: (id) => (/\/src\/host\/(main|router|audio-stats|names)\.ts$|vite\/preload-helper/.test(id) ? "host" : undefined) } },
  },
});
