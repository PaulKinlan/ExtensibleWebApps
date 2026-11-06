import { defineConfig, type Plugin } from "vite";

// Plugin workers get their content security policy from the response that
// serves their script. No plugin may load scripts other than its own module
// (a blob: URL); only plugins with the `network` permission may connect out.
export const WORKER_CSP = "default-src 'none'; script-src 'self' blob:; connect-src 'none'";
export const NETWORK_WORKER_CSP = "default-src 'none'; script-src 'self' blob:; connect-src 'self' https: wss:";

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

export default defineConfig({
  plugins: [workerPolicy()],
  worker: { format: "es" },
  build: { target: "es2022" },
});
