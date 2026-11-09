// Makes a new app from the starter: copies starter/ into a new folder, names
// it, and checks it.
//
//   npm run new-app -- packing-list                    makes demos/packing-list/
//   npm run new-app -- packing-list --name "Packing"   with that name on the page
//   npm run new-app -- ../elsewhere/packing-list       any folder that doesn't exist yet
//
// The plugin's id is the folder's name, so it must be lowercase letters,
// digits and dashes. Then run `npm run dev` and open the address it prints.

import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkApps } from "./check.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STARTER = join(ROOT, "starter");

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Copies the starter to `target` and renames it; returns the new folder. */
export function newApp(target, name) {
  const folder = target.includes("/") ? resolve(target) : join(ROOT, "demos", target);
  const id = basename(folder);
  // The id names the plugin and, with "-items", its collection, whose names are at most 41 characters.
  if (!/^[a-z][a-z0-9-]{0,34}$/.test(id)) throw new Error(`The folder's name is the plugin's id, so it must be lowercase letters, digits and dashes, starting with a letter, at most 35 long: not "${id}"`);
  if (existsSync(folder)) throw new Error(`${relative(process.cwd(), folder) || folder} already exists`);
  const title = (name || id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())).trim().slice(0, 80);
  cpSync(STARTER, folder, { recursive: true });
  for (const file of readdirSync(folder)) {
    const path = join(folder, file);
    // In JavaScript the name goes inside a string, escaped as JSON; in HTML, as text.
    const named = file.endsWith(".js") ? JSON.stringify(title).slice(1, -1) : escapeHtml(title);
    const text = readFileSync(path, "utf8")
      .replace(/my-app/g, () => id)
      .replace(/My app/g, () => named);
    writeFileSync(path, text);
  }
  return folder;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const nameAt = args.indexOf("--name");
  const name = nameAt >= 0 ? args.splice(nameAt, 2)[1] : undefined;
  if (args.length !== 1) {
    console.error('Usage: npm run new-app -- <folder> [--name "My app"]');
    process.exit(2);
  }
  try {
    const folder = newApp(args[0], name);
    const [app] = await checkApps([folder]);
    for (const p of app.problems) console.log(`${p.level} ${p.file}${p.line ? `:${p.line}` : ""}  ${p.message}`);
    // An app that doesn't pass the check isn't a success, whatever made it.
    if (app.problems.some((p) => p.level === "error")) process.exitCode = 1;
    const where = relative(ROOT, folder);
    console.log(`Made ${where}/`);
    if (!where.startsWith("..")) console.log(`Run \`npm run dev\` and open http://localhost:5173/${where}/app.html`);
    if (where.startsWith("demos/")) console.log("Change its <meta name=\"gallery-…\"> card text: the demo gallery lists it from those tags.");
    else console.log("It's outside this repo: serve it next to the platform's /platform/ and /std/ files to open it.");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
