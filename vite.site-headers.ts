// Sends public/_headers in development (`npm run dev`) and in `vite preview`
// (what `npm test` runs), as Cloudflare and the Node server do, so the pages'
// policies (Trusted Types, Permissions-Policy) and the plugin workers' apply
// on this machine too, and a change that breaks them fails the tests.

import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { headerRules } from "./src/server/header-rules.ts";

export function siteHeaders(): Plugin {
  const middleware = (file: string) => {
    const rules = headerRules(file);
    return (req: { url?: string }, res: { setHeader(k: string, v: string): void }, next: () => void) => {
      let path: string;
      try {
        path = decodeURIComponent(new URL(req.url ?? "/", "http://host").pathname);
      } catch {
        return next();
      }
      for (const rule of rules) if (rule.path.test(path)) for (const [name, value] of Object.entries(rule.headers)) res.setHeader(name, value);
      next();
    };
  };
  return {
    name: "site-headers",
    configureServer: (server) => void server.middlewares.use(middleware(resolve("public/_headers"))),
    configurePreviewServer: (server) => void server.middlewares.use(middleware(join(resolve("dist"), "_headers"))),
  };
}
