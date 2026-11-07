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

// Folders the browser runs as written: served untouched in development (no
// transforms, no injected scripts) and copied unchanged into the build.
const AS_WRITTEN = ["elements"];
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".md": "text/markdown" };

function asWritten(): Plugin {
  const root = process.cwd();
  const files = (dir: string): string[] =>
    readdirSync(join(root, dir)).flatMap((name) => (statSync(join(root, dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
  return {
    name: "as-written",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent(new URL(req.url ?? "/", "http://host").pathname);
        const dir = AS_WRITTEN.find((d) => path.startsWith(`/${d}/`));
        const file = resolve(root, `.${path}`);
        if (!dir || !file.startsWith(resolve(root, dir) + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of AS_WRITTEN) for (const file of files(dir)) this.emitFile({ type: "asset", fileName: file.split(sep).join("/"), source: readFileSync(join(root, file)) });
    },
  };
}

export default defineConfig({
  plugins: [workerPolicy(), asWritten()],
  worker: { format: "es" },
  build: { target: "es2022" },
});
