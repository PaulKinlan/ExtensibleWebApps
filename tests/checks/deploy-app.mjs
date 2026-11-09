// `npm run deploy:app` (scripts/deploy-app.mjs): one app laid out as a Worker
// of its own. Its site has the platform and that app, none of this site's
// own pages, the folders the app links with ../, and a front page that is the
// app; its config is the site's Worker under a new name, marked with the app.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutApp } from "../../scripts/deploy-app.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default async function ({ check }) {
  const out = mkdtempSync(join(tmpdir(), "ewa-app-"));
  try {
    const { site, path, worker, warnings } = layoutApp("demos/habits", { out });
    const has = (p) => existsSync(join(site, p));
    check("an app's Worker serves the platform", ["platform/host.js", "platform/host.css", "sw.js", "404.html", "_headers", "std/debug-console.js", "account/app.html"].every(has));
    check("an app's Worker serves the app at the path it has here", path === "demos/habits" && has("demos/habits/app.html") && worker === "habits");
    check("an app's Worker leaves out this site's own pages", !has("docs") && !has("workbench") && !has("home") && !has("demos/reading-list") && !has("demos/index.html"));
    const front = readFileSync(join(site, "index.html"), "utf8");
    check("an app's Worker serves the app at / too: its front page is the app's page, with a <base> naming the app's folder", /<head>\s*<!--[^>]*-->\s*<base href="\/demos\/habits\/">/.test(front) && /<link rel="plugin" href="habits.js">/.test(front) && !/class="site"/.test(front), front.slice(0, 300));
    const config = JSON.parse(readFileSync(join(out, "wrangler.jsonc"), "utf8").replace(/^\/\/.*$/gm, ""));
    check(
      "an app's Worker is the site's Worker under the app's name",
      config.name === "habits" && config.assets.directory === "./site" && existsSync(resolve(out, config.main)) && config.durable_objects.bindings.length >= 2 && config.worker_loaders?.length === 1 && config.vars?.EXTENSIBLE_APP === "demos/habits",
      JSON.stringify(config),
    );
    const deployed = readFileSync(join(site, "demos/habits/app.html"), "utf8");
    check("an app's Worker leaves out the main site's navigation", !/class="site"/.test(deployed) && !deployed.includes("/workbench/") && /<slot name="main">/.test(deployed) && !warnings.length, warnings.join("; "));
    check("deploying leaves the app's own app.html as it was", readFileSync(join(root, "demos/habits/app.html"), "utf8").includes('href="/workbench/"'));

    // The security demo links plugins from two other demos with ../: those folders come too.
    const security = layoutApp("demos/security", { out, name: "security-test" });
    check("an app's Worker brings the folders its app.html links with ../", ["demos/reading-list/library.js", "demos/librarian/activity.js"].every((p) => existsSync(join(security.site, p))));

    // An app outside the repo, linking a sibling folder without quotes: both come, at the same distance apart.
    const away = mkdtempSync(join(tmpdir(), "ewa-away-"));
    try {
      cpSync(join(root, "starter"), join(away, "trip-kit"), { recursive: true });
      mkdirSync(join(away, "shared", "widgets"), { recursive: true });
      writeFileSync(join(away, "shared", "widgets", "w.js"), "");
      writeFileSync(join(away, "shared", "lib.js"), "");
      const page = join(away, "trip-kit", "app.html");
      writeFileSync(page, readFileSync(page, "utf8").replace("</head>", "<link rel=plugin href=../shared/widgets/w.js>\n<link rel=plugin href=../shared/lib.js>\n</head>").replace("</body>", '<a href="/nowhere/">Elsewhere</a>\n<nav class="site-tools">Tools</nav>\n<nav data-class="site">Mine</nav>\n<nav class="compact site"><a href="/docs/">Docs</a></nav>\n</body>'));
      const external = layoutApp(join(away, "trip-kit"), { out });
      const navs = readFileSync(join(external.site, "trip-kit/app.html"), "utf8");
      check("only a nav whose class has the token `site` is left out", navs.includes("site-tools") && navs.includes('data-class="site"') && !navs.includes("compact site"));
      check("deploy:app warns about links to pages the Worker won't have", external.warnings.some((w) => w.includes("/nowhere/")), external.warnings.join("; "));
      check(
        "an app outside the repo brings its ../ folders, quoted or not",
        external.path === "trip-kit" && existsSync(join(external.site, "trip-kit/app.html")) && existsSync(join(external.site, "shared/widgets/w.js")) && existsSync(join(external.site, "shared/lib.js")),
      );
      writeFileSync(page, readFileSync(page, "utf8").replace("</head>", '<link rel="plugin" href="../../too-far.js">\n</head>'));
      let above = "";
      try {
        layoutApp(join(away, "trip-kit"), { out });
      } catch (error) {
        above = error.message;
      }
      check("deploy:app refuses an app linking above the site's root", /outside/.test(above), above);
    } finally {
      rmSync(away, { recursive: true, force: true });
    }

    // A top-level folder of this repo is an app too, though the build copies it into dist/ as well.
    const top = join(root, "zz-deploy-app-check");
    try {
      cpSync(join(root, "starter"), top, { recursive: true });
      const own = layoutApp(top, { out });
      check("a top-level folder of the repo deploys as an app", own.path === "zz-deploy-app-check" && existsSync(join(own.site, "zz-deploy-app-check/app.html")));
    } finally {
      rmSync(top, { recursive: true, force: true });
    }

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
