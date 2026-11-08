// `npx github:PaulKinlan/ExtensibleWebApps <folder>` (scripts/create-app.mjs):
// it copies the platform's source and nothing built or installed, names the
// project after the folder, refuses bad names and folders in use, and the
// command npm finds is that script. And the homepage's chapter 10 shows it.
//
// It copies with --no-install, so it needs no network: `npm install` and
// `npm run new-app` are the repo's own, checked elsewhere (app-check.mjs).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyPlatform } from "../../scripts/create-app.mjs";

export default async function ({ check, context, URL, errors }) {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  check("npx finds scripts/create-app.mjs as the repo's one command", pkg.bin?.["create-extensible-app"] === "scripts/create-app.mjs" && readFileSync("scripts/create-app.mjs", "utf8").startsWith("#!/usr/bin/env node"));

  const scratch = mkdtempSync(join(tmpdir(), "create-app-"));
  try {
    const run = (...args) => spawnSync(process.execPath, ["scripts/create-app.mjs", ...args], { encoding: "utf8" });
    const made = run(join(scratch, "packing-list"), "--no-install");
    const folder = join(scratch, "packing-list");
    const copy = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
    const has = (p) => existsSync(join(folder, p));
    check(
      "create-app copies the platform's source, not what's built or installed, and names the project",
      made.status === 0 && has("src/host") && has("std") && has("starter/app.html") && has("scripts/new-app.mjs") && has(".gitignore") && !has("node_modules") && !has("dist") && !has(".git") && copy.name === "packing-list" && !copy.bin && copy.scripts?.["new-app"],
      `${made.status} ${made.stderr}`,
    );
    check("create-app says what to run next", /npm run new-app -- packing-list/.test(made.stdout), made.stdout);
    const again = run(folder, "--no-install");
    check("create-app won't copy into a folder that has files in it", again.status === 1 && /isn't empty/.test(again.stderr), again.stderr);
    let refused = "";
    try { copyPlatform(join(scratch, "Packing_List")); } catch (error) { refused = error.message; }
    let demo = "";
    try { copyPlatform(join(scratch, "habits")); } catch (error) { demo = error.message; }
    check("create-app refuses a name a demo already has, before copying anything", /already a demo/.test(demo) && !existsSync(join(scratch, "habits")), demo);
    const noTitle = run(join(scratch, "titled"), "--name", "--no-install");
    check("create-app refuses --name with no title, and copies nothing", noTitle.status === 2 && /--name needs a title/.test(noTitle.stderr) && !existsSync(join(scratch, "titled")), noTitle.stderr);
    check("create-app refuses a folder name that can't be an app's id", /lowercase letters/.test(refused) && !existsSync(join(scratch, "Packing_List")), refused);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const own = await context.browser().newContext();
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL);
  const chapter = 'slot[name="your-app"] .chapter';
  const shown = await page.waitForSelector(`${chapter} >> text=npx github:PaulKinlan/ExtensibleWebApps packing-list`, { state: "attached", timeout: 8000 }).then(() => true, () => false);
  const appHtml = shown && (await page.textContent(`${chapter} pre`)).includes('<link rel="plugin" href="main.js">');
  check("chapter 10 shows an app.html as text and the command that makes an app of your own", shown && appHtml);
  await own.close();
}
