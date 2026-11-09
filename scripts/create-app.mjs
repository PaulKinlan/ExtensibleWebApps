#!/usr/bin/env node
// Makes a project of your own: one app, whose files are at the top of the
// project, with the platform as a dependency. No checkout of this repo needed.
//
//   npm create extensible-app packing-list           (scripts/create-extensible-app/ runs the line below)
//   npx github:PaulKinlan/ExtensibleWebApps packing-list
//   npx github:PaulKinlan/ExtensibleWebApps packing-list --name "Packing"
//   npx github:PaulKinlan/ExtensibleWebApps packing-list --no-install
//   npx github:PaulKinlan/ExtensibleWebApps packing-list --platform file:../ExtensibleWebApps
//
// That makes ./packing-list/:
//
//   package.json   depends on the platform; `npm run dev`, `check` and `deploy` run its
//                  extensible-app command (scripts/extensible-app.mjs)
//   app.html       the app's page, from the starter: a list you can add to and tick off
//   main.js        its plugin, and main.html, its template
//   README.md, .gitignore
//
// and runs `npm install` in it. Then:
//
//   cd packing-list
//   npm run dev          http://localhost:5173/
//   npm run deploy       the app on a Cloudflare Worker of its own, at /
//
// The folder's name is the app's id, so it must be lowercase letters, digits
// and dashes. --platform names where the platform comes from, as npm writes a
// dependency: GitHub's main by default, or a local checkout to try a change.
// It only uses Node's own modules, since npx installs no devDependencies.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where this copy of the platform is: the repo, or npx's copy of it. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where a project gets the platform from, until it's on npm. */
export const PLATFORM_SPEC = "github:PaulKinlan/ExtensibleWebApps";

/** The same rule as `npm run new-app`: the id names the plugin and its collection. */
const ID = /^[a-z][a-z0-9-]{0,34}$/;

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const GITIGNORE = ["node_modules", ".extensible"].join("\n") + "\n";

/**
 * The ids no plugin may have, read from the platform's source as the kernel has them: RESERVED in
 * src/kernel/manifest.ts, each service in src/kernel/services/, and each kernel module kernel.json lists.
 * (Read as text: npx installs no TypeScript tools.)
 */
export function reservedIds(root = ROOT) {
  const manifest = readFileSync(join(root, "src/kernel/manifest.ts"), "utf8");
  const listed = /export const RESERVED = new Set\(\[([^\]]*)\]/.exec(manifest)?.[1] ?? "";
  const services = readdirSync(join(root, "src/kernel/services")).filter((f) => f.endsWith(".ts") && f !== "index.ts").map((f) => f.slice(0, -3));
  const { modules = [] } = JSON.parse(readFileSync(join(root, "kernel.json"), "utf8"));
  return new Set([...listed.matchAll(/"([^"]+)"/g)].map((m) => m[1]).concat(services, modules));
}

/**
 * Makes the project in `target` (which mustn't exist yet, or must be empty): the app from the starter, at the
 * top, and a package.json that depends on the platform. Installs nothing. Returns the folder and the app's id.
 * @param {string} target @param {{ name?: string, platform?: string }} [options]
 */
export function makeProject(target, { name, platform = PLATFORM_SPEC } = {}) {
  const folder = resolve(target);
  const id = basename(folder);
  if (!ID.test(id)) throw new Error(`The folder's name is your app's id, so it must be lowercase letters, digits and dashes, starting with a letter, at most 35 long: not "${id}"`);
  if (reservedIds().has(id)) throw new Error(`"${id}" is a name the platform keeps for itself (its kernel, or one of its services), so it can't be your app's id: pick another name for the folder`);
  if (existsSync(folder) && readdirSync(folder).length) throw new Error(`${relative(process.cwd(), folder) || folder} already exists and isn't empty`);
  // The starter, named, as `npm run new-app` does (scripts/new-app.mjs, which also checks it: that needs the
  // checks' build tools, which npx doesn't install, so `npm run check` in the project does that).
  const title = (name || id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())).trim().slice(0, 80);
  cpSync(join(ROOT, "starter"), folder, { recursive: true });
  for (const file of readdirSync(join(ROOT, "starter"))) {
    const path = join(folder, file);
    // In JavaScript the name goes inside a string, escaped as JSON; in HTML, as text.
    const named = file.endsWith(".js") ? JSON.stringify(title).slice(1, -1) : escapeHtml(title);
    writeFileSync(path, readFileSync(path, "utf8").replace(/my-app/g, () => id).replace(/My app/g, () => named));
  }

  // The starter's card for this repo's demo gallery means nothing in a project of its own.
  const page = join(folder, "app.html");
  writeFileSync(page, readFileSync(page, "utf8").replace(/\n\s*<!-- Its card in the demo gallery[^\n]*-->(\n\s*<meta name="gallery[^\n]*>)+/, ""));

  const platformPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const pkg = {
    name: id,
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: {
      dev: "extensible-app dev",
      check: "extensible-app check",
      deploy: "extensible-app deploy",
    },
    dependencies: { [platformPkg.name]: platform },
    // `npm run deploy` puts the app on Cloudflare with it.
    devDependencies: { wrangler: platformPkg.devDependencies.wrangler },
    engines: platformPkg.engines,
  };
  writeFileSync(join(folder, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(join(folder, ".gitignore"), GITIGNORE);
  writeFileSync(
    join(folder, "README.md"),
    `# ${title}

An app on [Extensible Web Apps](https://extensibleweb.app/): whoever uses it can switch its plugins off, read them, and add their own.

- \`app.html\` is the app's page: it loads the platform, lays out slots, and lists its plugins.
- \`main.js\` is its first plugin, and \`main.html\` that plugin's template.

\`\`\`sh
npm run dev       # http://localhost:5173/
npm run check     # find mistakes without opening a browser
npm run deploy    # on a Cloudflare Worker of its own (run \`npx wrangler login\` once first)
\`\`\`

The platform is a dependency (\`${platformPkg.name}\` in package.json), not a copy. Its guide is at https://extensibleweb.app/docs/guide/, and this kind of project is explained in https://extensibleweb.app/docs/guide/your-own-app.
`,
  );
  return { folder, id };
}

// npx runs it through a link in node_modules/.bin, so compare the file the link points at.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const take = (flag, what) => {
    const at = args.indexOf(flag);
    if (at < 0) return undefined;
    const value = args.splice(at, 2)[1];
    if (!value || value.startsWith("--")) {
      console.error(`${flag} needs ${what} after it`);
      process.exit(2);
    }
    return value;
  };
  const name = take("--name", 'a title: --name "Packing list"');
  const platform = take("--platform", "where the platform comes from: --platform file:../ExtensibleWebApps");
  const noInstall = args.includes("--no-install");
  const rest = args.filter((a) => a !== "--no-install");
  if (rest.length !== 1 || rest[0].startsWith("-")) {
    console.error('Usage: npm create extensible-app <folder> [--name "My app"] [--no-install] [--platform <npm dependency>]');
    process.exit(2);
  }
  let made;
  try {
    made = makeProject(rest[0], { name, platform });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const where = relative(process.cwd(), made.folder) || ".";
  console.log(`Made your app in ${where}/`);
  if (noInstall) {
    console.log(`\nNext:\n  cd ${where}\n  npm install\n  npm run dev`);
    process.exit(0);
  }
  console.log("Installing the platform (the first time from GitHub, it builds it, which takes a minute)…");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // npm.cmd needs a shell on Windows, so only the fixed `npm install` goes through one.
  if (spawnSync(npm, ["install"], { cwd: made.folder, stdio: "inherit", shell: process.platform === "win32" }).status !== 0) {
    console.error(`\n\`npm install\` didn't finish. Run it in ${where}/, then \`npm run dev\`.`);
    process.exit(1);
  }
  console.log(`
Your app is in ${where}/: app.html lists its plugins, and main.js is the first one.

  cd ${where}
  npm run dev       then open http://localhost:5173/
  npm run check     find mistakes without a browser
  npm run deploy    your app on a Cloudflare Worker of its own (npx wrangler login, once)`);
}
