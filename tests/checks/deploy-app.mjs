// `npm run deploy:app` (scripts/deploy-app.mjs): one app laid out as a Worker
// of its own. Its site has the platform and that app, none of this site's
// own pages, the folders the app links with ../, and a front page that sends
// people to the app; its config is the site's Worker under a new name.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { layoutApp } from "../../scripts/deploy-app.mjs";

export default async function ({ check }) {
  const out = mkdtempSync(join(tmpdir(), "ewa-app-"));
  try {
    const { site, path, worker, warnings } = layoutApp("demos/habits", { out });
    const has = (p) => existsSync(join(site, p));
    check("an app's Worker serves the platform", ["platform/host.js", "platform/host.css", "sw.js", "404.html", "_headers", "std/debug-console.js", "account/index.html"].every(has));
    check("an app's Worker serves the app at the path it has here", path === "demos/habits" && has("demos/habits/app.html") && worker === "habits");
    check("an app's Worker leaves out this site's own pages", !has("docs") && !has("workbench") && !has("home") && !has("demos/reading-list") && !has("demos/index.html"));
    check("an app's front page sends people to the app", /location\.replace\("\/demos\/habits\/"/.test(readFileSync(join(site, "index.html"), "utf8")));
    const config = JSON.parse(readFileSync(join(out, "wrangler.jsonc"), "utf8").replace(/^\/\/.*$/gm, ""));
    check(
      "an app's Worker is the site's Worker under the app's name",
      config.name === "habits" && config.assets.directory === "./site" && existsSync(resolve(out, config.main)) && config.durable_objects.bindings.length >= 2 && config.worker_loaders?.length === 1,
      JSON.stringify(config),
    );
    check("deploy:app warns about links to pages the Worker won't have", warnings.some((w) => w.includes("/docs/")), warnings.join("; "));

    // The security demo links plugins from two other demos with ../: those folders come too.
    const security = layoutApp("demos/security", { out, name: "security-test" });
    check("an app's Worker brings the folders its app.html links with ../", ["demos/reading-list/library.js", "demos/librarian/activity.js"].every((p) => existsSync(join(security.site, p))));

    let refused = "";
    try {
      layoutApp("demos/habits", { out, name: "Not_A_Name" });
    } catch (error) {
      refused = error.message;
    }
    check("deploy:app refuses a name Cloudflare wouldn't take", /can't name a Worker/.test(refused), refused);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
