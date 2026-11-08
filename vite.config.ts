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
const NOT_SERVED = [
  "dist",
  "docs",
  "node_modules",
  "plugins", // built into the kernel
  "public", // Vite copies it itself
  "scripts",
  "src", // built
  "tests",
];
const asWrittenPaths = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .filter((e) => (e.isDirectory() ? !NOT_SERVED.includes(e.name) : e.isFile() && /\.(html|js)$/.test(e.name)))
    .map((e) => e.name)
    .sort();
// Two stable URLs every page uses: the platform's stylesheet and its host
// script. In development the script redirects to the TypeScript source (so
// its relative worker URLs resolve); in the build it is emitted at this path.
const HOST_CSS = "src/host/styles.css";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".md": "text/markdown" };

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
        const paths = asWrittenPaths(root);
        // A top-level file is served only by its exact name ("/" is index.html); a folder serves what is inside it.
        const name = path === "/" ? "index.html" : path.slice(1);
        if (paths.includes(name) && statSync(join(root, name)).isFile()) return serve(res, resolve(root, name));
        const top = paths.find((d) => statSync(join(root, d)).isDirectory() && path.startsWith(`/${d}/`));
        const file = resolve(root, `.${path}`);
        if (!top || !file.startsWith(resolve(root, top) + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        return serve(res, file);
      });
    },
    generateBundle() {
      for (const path of asWrittenPaths(root)) for (const file of files(path)) this.emitFile({ type: "asset", fileName: file.split(sep).join("/"), source: readFileSync(join(root, file)) });
      this.emitFile({ type: "asset", fileName: "platform/host.css", source: readFileSync(join(root, HOST_CSS)) });
    },
  };
}

export default defineConfig({
  plugins: [workerPolicy(), asWritten()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    // The host is the one entry: /platform/host.js, which every page loads. Pages themselves are copied as written.
    rollupOptions: { input: { host: "src/host/main.ts" }, output: { entryFileNames: "platform/[name].js" } },
  },
});
