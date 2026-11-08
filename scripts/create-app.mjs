#!/usr/bin/env node
// Makes a project of your own: a copy of the whole platform, with a new app
// in it made from the starter. No checkout of this repo needed.
//
//   npx github:PaulKinlan/ExtensibleWebApps packing-list
//   npx github:PaulKinlan/ExtensibleWebApps packing-list --name "Packing"
//   npx github:PaulKinlan/ExtensibleWebApps packing-list --no-install
//
// That makes ./packing-list/, a copy of this repo (the platform, the standard
// plugins, the demos to learn from, the scripts), runs `npm install` in it,
// and then `npm run new-app -- packing-list`, so the app is at
// packing-list/demos/packing-list/. Then:
//
//   cd packing-list
//   npm run dev                                 http://localhost:5173/demos/packing-list/
//   npm run deploy:app -- demos/packing-list    the app alone, on a Worker of its own
//
// The folder's name is the app's id, so it must be lowercase letters, digits
// and dashes. With --no-install it only copies, and says what to run next.
// It only uses Node's own modules, since npx installs no devDependencies.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where this copy of the platform is: the repo, or npx's copy of it. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** What a copy leaves out: what's installed, built or kept on this machine, never the source. */
export const LEFT_OUT = [".git", "node_modules", "dist", ".build", ".wrangler", ".spaces", "test-results"];

/** npm leaves .gitignore out of a package, so a copy made through npx writes its own. */
const GITIGNORE = ["node_modules", "dist", "test-results", ".build", ".spaces", ".wrangler"].join("\n") + "\n";

/** The same rule as `npm run new-app`: the id names the plugin and its collection. */
const ID = /^[a-z][a-z0-9-]{0,34}$/;

/**
 * Copies the platform to `target` (which mustn't exist yet, or must be empty) and names the project after it.
 * Returns the folder and the app's id. Makes no app: that's `npm run new-app`, once it's installed.
 * @param {string} target @param {{ from?: string }} [options]
 */
export function copyPlatform(target, { from = ROOT } = {}) {
  const folder = resolve(target);
  const id = basename(folder);
  if (!ID.test(id)) throw new Error(`The folder's name is your app's id, so it must be lowercase letters, digits and dashes, starting with a letter, at most 35 long: not "${id}"`);
  if (existsSync(folder) && readdirSync(folder).length) throw new Error(`${relative(process.cwd(), folder) || folder} already exists and isn't empty`);
  const source = (path) => relative(from, path).split(/[\\/]/)[0];
  cpSync(from, folder, { recursive: true, filter: (path) => !LEFT_OUT.includes(source(path)) });
  if (!existsSync(join(folder, ".gitignore"))) writeFileSync(join(folder, ".gitignore"), GITIGNORE);
  // The project is theirs now, named after their app; it isn't a way to make more projects.
  const pkgPath = join(folder, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.name = id;
  delete pkg.bin;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return { folder, id };
}

// npx runs it through a link in node_modules/.bin, so compare the file the link points at.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const nameAt = args.indexOf("--name");
  const name = nameAt >= 0 ? args.splice(nameAt, 2)[1] : undefined;
  const noInstall = args.includes("--no-install");
  const rest = args.filter((a) => a !== "--no-install");
  if (rest.length !== 1 || rest[0].startsWith("-")) {
    console.error('Usage: npx github:PaulKinlan/ExtensibleWebApps <folder> [--name "My app"] [--no-install]');
    process.exit(2);
  }
  let made;
  try {
    made = copyPlatform(rest[0]);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const { folder, id } = made;
  const where = relative(process.cwd(), folder) || ".";
  console.log(`Copied the platform to ${where}/`);
  const newApp = ["run", "new-app", "--", id, ...(name ? ["--name", name] : [])];
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = (cmdArgs) => spawnSync(npm, cmdArgs, { cwd: folder, stdio: "inherit", shell: process.platform === "win32" }).status === 0;
  const quoted = newApp.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");
  if (noInstall) {
    console.log(`\nNext:\n  cd ${where}\n  npm install\n  npm ${quoted}\n  npm run dev`);
    process.exit(0);
  }
  if (!run(["install"])) {
    console.error(`\n\`npm install\` didn't finish. Run it in ${where}/, then \`npm ${quoted}\`.`);
    process.exit(1);
  }
  if (!run(newApp)) process.exit(1);
  console.log(`
Your app is in ${where}/demos/${id}/: app.html lists its plugins, and main.js is the first one.

  cd ${where}
  npm run dev                                 then open http://localhost:5173/demos/${id}/
  npm run check                               find mistakes without a browser
  npm run deploy:app -- demos/${id}    your app alone, on a Cloudflare Worker of its own

The rest of the folder is the platform and its demos, to read and to change.`);
}
