// Every host sends the site's page policy (public/_headers): Trusted Types,
// scripts only from the site's files, and the Permissions-Policy, on the front
// page, a folder's page, an app's page and an app opened in a space; and the
// plugin workers' runtime keeps its own policy alone, not joined with the
// pages'. tests/checks/page-policy.mjs checks the same against `vite preview`.

import { readdirSync } from "node:fs";

/** @param {string} base @param {(what: string, ok: unknown, detail?: string) => void} check @param {string} cookie a member of the space "family" */
export async function pagePolicyChecks(base, check, cookie) {
  const pages = ["/", "/docs/", "/demos/habits/app.html", "/s/family/demos/habits/app.html"];
  const seen = [];
  for (const path of pages) {
    const response = await fetch(`${base}${path}`, { headers: { cookie } }).catch(() => undefined);
    const csp = response?.headers.get("content-security-policy") ?? "";
    seen.push({ path, at: response && new URL(response.url).pathname, status: response?.status, csp: !!csp, permissions: !!response?.headers.get("permissions-policy") });
    void response?.body?.cancel();
    if (!/require-trusted-types-for 'script'/.test(csp) || !/script-src 'self'/.test(csp) || !response?.headers.get("permissions-policy")) {
      check("page policy: every page is sent with Trusted Types, its script sources and the Permissions-Policy", false, JSON.stringify(seen));
      return;
    }
  }
  check("page policy: every page is sent with Trusted Types, its script sources and the Permissions-Policy", true, JSON.stringify(seen));
  const runtime = readdirSync("dist/assets").find((f) => /^runtime-[\w-]+\.js$/.test(f));
  const worker = await fetch(`${base}/assets/${runtime}`);
  const policy = worker.headers.get("content-security-policy") ?? "";
  void worker.body?.cancel();
  check("page policy: the plugin workers' runtime has its own policy, not the pages' joined to it", /connect-src 'none'/.test(policy) && !/trusted-types/.test(policy), policy);
}
