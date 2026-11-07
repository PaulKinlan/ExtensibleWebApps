// `npm run check` (scripts/check.mjs) and `npm run new-app` (scripts/new-app.mjs):
// every demo and the starter pass the check, the broken fixture fails it in
// each way it should, a new app is named and passes, and the starter works
// in a browser.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkApps } from "../../scripts/check.mjs";
import { newApp } from "../../scripts/new-app.mjs";

export default async function ({ check, openTab, URL }) {
  const demos = await checkApps([]);
  const dirty = demos.filter((app) => app.problems.length);
  check("npm run check finds nothing wrong in any demo", demos.length >= 2 && !dirty.length, dirty.map((app) => `${app.app}: ${app.problems.map((p) => p.message).join("; ")}`).join(" | "));

  const [starter] = await checkApps(["starter"]);
  check("npm run check finds nothing wrong in the starter", !starter.problems.length, starter.problems.map((p) => p.message).join("; "));

  // The fixture has one mistake of each kind; each must be found, at the right file.
  const [broken] = await checkApps(["tests/fixtures/broken-app"]);
  const found = (file, pattern) => broken.problems.some((p) => p.file.endsWith(file) && pattern.test(p.message));
  const expected = [
    ["app.html", /doesn't load the platform/],
    ["app.html", /missing\.js doesn't exist/],
    ["not-first.js", /must start with `export const manifest/],
    ["twin.js", /id "careless" is also used/],
    ["careless.js", /ctx\.routes\.add needs "routes"/],
    ["careless.js", /fetch needs "network"/],
    ["careless.js", /"data:read:library"/],
    ["careless.js", /no data\.frobnicate/],
    ["careless.js", /debug:trace.*"debug:read"/],
    ["careless.js", /no tests\/fixtures\/broken-app\/gone\.html/],
    ["careless.js", /no <template id="nope">/],
    ["careless.js", /views\.render needs "ui"/],
    ["careless.js", /slot "side"/],
    ["careless.js", /no <template id="list"> in other\.html/],
    ["careless.html", /<script> isn't allowed/],
    ["careless.html", /style= isn't allowed/],
    ["careless.html", /onclick= isn't allowed/],
    ["careless.html", /<marquee> isn't on the HTML allowlist/],
    ["careless.html", /javascript:void 0/],
    ["careless.html", /type="file"/],
  ];
  const missed = expected.filter(([file, pattern]) => !found(file, pattern));
  const owned = broken.problems.some((p) => /jottings/.test(p.message));
  check("npm run check finds each kind of mistake in the broken fixture, and allows a plugin its own collection", !missed.length && !owned, missed.map(([f, p]) => `${f} ${p}`).join("; "));

  // Valid but unusual HTML and JavaScript: quotes of any kind, a query on a link, a view file from
  // the site's root, and calls written inside strings, which aren't calls.
  const [quirky] = await checkApps(["tests/fixtures/quirky-app"]);
  check("npm run check accepts any quoting, queries on links, root-relative views, and ignores calls inside strings", !quirky.problems.length, quirky.problems.map((p) => p.message).join("; "));

  // A new app outside the repo: named after its folder, and clean.
  const scratch = mkdtempSync(join(tmpdir(), "new-app-"));
  try {
    const folder = newApp(join(scratch, "packing-list"), "Packing list");
    const [made] = await checkApps([folder]);
    const source = readFileSync(join(folder, "main.js"), "utf8");
    const page = readFileSync(join(folder, "app.html"), "utf8");
    check("npm run new-app copies the starter, names it after its folder, and it passes the check", !made.problems.length && /id: "packing-list"/.test(source) && /<h1>Packing list<\/h1>/.test(page), made.problems.map((p) => p.message).join("; "));
    let refused = "";
    try {
      newApp(join(scratch, "packing-list"));
    } catch (error) {
      refused = error.message;
    }
    check("npm run new-app won't overwrite a folder that exists", /already exists/.test(refused), refused);

    // Its collection is its own, and its name is escaped for each file it goes in.
    const odd = newApp(join(scratch, "odd-app"), 'Tom\\ & "Jerry" $& <b>');
    const oddSource = readFileSync(join(odd, "main.js"), "utf8");
    const [oddChecked] = await checkApps([odd]);
    check("a new app owns a collection named after it, and its name is escaped in JavaScript and HTML", /"odd-app-items"/.test(oddSource) && !/"my-app/.test(oddSource) && /<h1>Tom\\ &amp; &quot;Jerry&quot; \$&amp; &lt;b&gt;<\/h1>/.test(readFileSync(join(odd, "app.html"), "utf8")) && !oddChecked.problems.length, oddChecked.problems.map((p) => p.message).join("; "));

    // The command fails when what it made doesn't pass the check (kernel is a reserved id).
    const reserved = spawnSync(process.execPath, ["scripts/new-app.mjs", join(scratch, "kernel")], { encoding: "utf8" });
    check("npm run new-app exits with an error when the app it made has errors", reserved.status === 1 && /reserved/.test(reserved.stdout), `${reserved.status} ${reserved.stdout}`);

    // The platform's script must be a module.
    mkdirSync(join(scratch, "classic"));
    writeFileSync(join(scratch, "classic", "app.html"), '<script src="/platform/host.js"></script>');
    const [classic] = await checkApps([join(scratch, "classic")]);
    check("npm run check says when the platform's script isn't a module", classic.problems.some((p) => /is a module/.test(p.message)), classic.problems.map((p) => p.message).join("; "));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // The starter in a browser: add an item, tick it off, remove it.
  const page = await openTab(`${URL}starter/app.html`);
  const view = '[data-key="my-app:items"]';
  await page.fill(`${view} ui-form input[name=title]`, "Toothbrush", { timeout: 8000 });
  await page.click(`${view} ui-form button[type=submit]`);
  await page.check(`${view} li:has-text("Toothbrush") input[type=checkbox]`, { timeout: 5000 });
  const ticked = await page.waitForSelector(`${view} li[data-done]:has-text("Toothbrush")`, { timeout: 5000 }).then(() => true, () => false);
  await page.click(`${view} li:has-text("Toothbrush") button[data-action^="remove:"]`);
  const removed = await page.waitForSelector(`${view} li:has-text("Toothbrush")`, { state: "detached", timeout: 5000 }).then(() => true, () => false);
  check("the starter adds an item, ticks it off and removes it", ticked && removed, `ticked ${ticked}, removed ${removed}`);
  await page.close({ runBeforeUnload: true });
}
