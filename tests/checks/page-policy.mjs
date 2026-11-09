// The site's page policy (public/_headers): Trusted Types, scripts only from
// the site's files, and a Permissions-Policy, on every page. The runner fails
// the whole run on any page that breaks it (tests/policy-watch.mjs); these
// check the policy itself: that it is sent, that the browser enforces it, that
// made apps get the same (sw/made-page.js), and that no page holds an inline
// script it would refuse. tests/server/page-policy.mjs checks the Node and
// Cloudflare hosts send it too.
import { watchErrors } from "../page-errors.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PAGE_CSP, PERMISSIONS_POLICY } from "../../sw/made-page.js";

const ROOT = new globalThis.URL("../../", import.meta.url);

export default async function ({ check, context, URL, errors }) {
  // The four page rules in _headers say the same thing.
  const headers = readFileSync(new globalThis.URL("public/_headers", ROOT), "utf8");
  const rules = [...headers.matchAll(/^(\/[^\n]*)\n((?:[ \t]+[^\n]+\n?)+)/gm)].map((m) => ({ path: m[1].trim(), body: m[2].trim() }));
  const pageRules = rules.filter((r) => ["/", "/*/", "/*/app", "/*.html"].includes(r.path));
  const header = (body, name) => new RegExp(`^\\s*${name}:\\s*(.*)$`, "mi").exec(body)?.[1].trim() ?? "";
  const csp = header(pageRules[0]?.body ?? "", "Content-Security-Policy");
  const permissions = header(pageRules[0]?.body ?? "", "Permissions-Policy");
  check("_headers gives every page (/, folders, apps, .html) the same policy", pageRules.length === 4 && pageRules.every((r) => r.body === pageRules[0].body), pageRules.map((r) => r.path).join(" "));
  check(
    "the page policy enforces Trusted Types, takes scripts only from the site, and no plugins or <base> elsewhere",
    /require-trusted-types-for 'script'/.test(csp) && /trusted-types [^;]*\bplatform\b/.test(csp) && /script-src 'self'/.test(csp) && !/unsafe-inline|unsafe-eval/.test(csp) && /object-src 'none'/.test(csp) && /base-uri 'self'/.test(csp),
    csp,
  );
  const policies = (s) => /trusted-types ([^;]*)/.exec(s)?.[1].trim();
  check("an app made in the browser gets the same Trusted Types and Permissions-Policy (sw/made-page.js)", policies(PAGE_CSP) === policies(csp) && /require-trusted-types-for 'script'/.test(PAGE_CSP) && PERMISSIONS_POLICY === permissions, `${policies(PAGE_CSP)} | ${policies(csp)}`);
  check("the Permissions-Policy turns off what no app uses", ["camera=()", "geolocation=()", "usb=()", "payment=()"].every((f) => permissions.includes(f)), permissions);

  // No page in the repo holds a script the policy would refuse: every <script> loads a file.
  const files = execFileSync("git", ["ls-files", "*.html"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter((f) => f && !/^(tests|vendor|elements)\//.test(f));
  const inline = files.filter((f) => [...readFileSync(new globalThis.URL(f, ROOT), "utf8").replace(/<!--[^]*?-->/g, "").matchAll(/<script\b([^>]*)>/gi)].some((m) => !/\bsrc=/i.test(m[1]) && !/type=["']?(speculationrules|application\/(ld\+)?json)/i.test(m[1])));
  check("no page holds an inline script (put it in a file next to the page)", !inline.length, inline.join(", "));
  // Nor an onclick= or other handler in its markup, which the policy refuses too (a plugin's view may, as the host drops it).
  const handlers = files.filter((f) => /<[a-z][^>]*\son[a-z]+\s*=/i.test(readFileSync(new globalThis.URL(f, ROOT), "utf8").replace(/<!--[^]*?-->/g, "")));
  check("no page holds an inline event handler (onclick= and the like)", !handlers.length, handlers.join(", "));

  // The development server sends it, as Cloudflare and the Node server do.
  // Through the browser's own request client, so "localhost" resolves as it does for the pages (IPv4 or IPv6).
  const sent = await Promise.all(["", "demos/habits/app.html", "docs/"].map((p) => context.request.get(`${URL}${p}`).then((r) => [p || "/", r.headers()["content-security-policy"] === csp && r.headers()["permissions-policy"] === permissions])));
  check("vite preview sends the page policy with each page", sent.every(([, ok]) => ok), JSON.stringify(sent));

  // The browser enforces it: a plain string can't become markup, and no other policy can be made.
  const own = await context.browser().newContext();
  const page = await own.newPage();
  watchErrors(page, errors, "page-policy");
  // Marked, so the runner doesn't count these refusals against the run (tests/policy-watch.mjs).
  await page.goto(`${URL}demos/habits/app.html#policy-probe`);
  await page.waitForFunction(() => window.__host, null, { timeout: 10000 });
  const enforced = await page.evaluate(() => {
    const tried = {};
    try {
      document.createElement("div").innerHTML = "<img src=x onerror=alert(1)>";
      tried.innerHTML = "allowed";
    } catch (error) {
      tried.innerHTML = error.name;
    }
    try {
      window.trustedTypes.createPolicy("sneaky", { createHTML: (s) => s });
      tried.policy = "allowed";
    } catch (error) {
      tried.policy = error.name;
    }
    try {
      const s = document.createElement("script");
      s.src = "https://example.com/x.js";
      tried.scriptUrl = "allowed";
    } catch (error) {
      tried.scriptUrl = error.name;
    }
    return tried;
  });
  check("the browser refuses markup from a plain string, an outside script's address, and a policy the page doesn't name", enforced.innerHTML === "TypeError" && enforced.policy === "TypeError" && enforced.scriptUrl === "TypeError", JSON.stringify(enforced));
  await own.close();
}
