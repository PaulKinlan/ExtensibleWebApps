// The kernel never becomes one big file (docs/layers.md, "The kernel stays
// small"). A kernel module is a file of its own that the browser's kernel
// fetches the first time something it adds is used, so an app's kernel is the
// core and the modules that app uses. The kernel knows what each module adds
// from the manifest beside it (std/<name>/module.json), without running it.
//
// Checked here: the build keeps each module out of the kernel's own file; a
// manifest the build doesn't understand stops it; an app that uses no module
// starts none; a module starts when its service is called, its hook is
// listened to or its command is run; and no manifest lists something its
// module never adds.
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moduleManifest, moduleManifests } from "../../vite.kernel-modules.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export default async function ({ check, context, URL: site }) {
  const { modules } = JSON.parse(readFileSync(join(ROOT, "kernel.json"), "utf8"));

  // The build: one file per module, and none of them inside the kernel's. The exception is a module whose
  // manifest says it starts with every kernel: every app runs it, so it is part of the kernel's own file, where it
  // costs no first visit a request made only after the kernel arrived (scripts/first-draw.mjs).
  const assets = join(ROOT, "dist", "assets");
  // This build's files, from the list the build writes (vite.parts.ts): dist/assets/ may also hold files kept from
  // earlier deploys for pages still open (scripts/keep-assets.mjs), an older kernel or module file among them.
  const parts = join(ROOT, "dist", "platform", "parts.json");
  const built = existsSync(parts) ? JSON.parse(readFileSync(parts, "utf8")).files.filter((f) => f.startsWith("/assets/")).map((f) => f.slice("/assets/".length)) : existsSync(assets) ? readdirSync(assets) : [];
  const kernelFile = built.find((f) => /^browser-[\w-]+\.js$/.test(f));
  const kernel = kernelFile ? readFileSync(join(assets, kernelFile), "utf8") : "";
  const always = modules.filter((name) => moduleManifest(name, ROOT).starts === "always");
  // A module that is only for a server (`"only": "server"`) is no part of the browser's kernel: no file, no name.
  const serverOnly = modules.filter((name) => moduleManifest(name, ROOT).only === "server");
  const onDemand = modules.filter((name) => !always.includes(name) && !serverOnly.includes(name));
  const inBrowser = serverOnly.filter((name) => built.some((f) => f.startsWith(`kernel-${name}-`)) || new RegExp(`name:\\s*"${name}"`).test(kernel));
  check("a module that is only for a server is left out of the browser's kernel: no file of its own, and not named in the kernel's", !!kernelFile && serverOnly.includes("acp") && !inBrowser.length, `in the browser's build: ${inBrowser.join(", ")}`);
  const noFile = onDemand.filter((name) => !built.some((f) => f.startsWith(`kernel-${name}-`)));
  check("the build makes each kernel module that starts when used a file of its own", !!kernelFile && !noFile.length, `no file for: ${noFile.join(", ")}`);
  // Each module's file is fetched by name from the kernel, never copied into it: the kernel only names the file.
  const named = onDemand.filter((name) => !new RegExp(`import\\("\\./kernel-${name}-[\\w-]+\\.js"\\)`).test(kernel));
  check("the kernel's own file only names each of those modules' files, to fetch when it is used", !named.length, `not fetched on demand: ${named.join(", ")}`);
  const apart = always.filter((name) => built.some((f) => f.startsWith(`kernel-${name}-`)));
  check("a module that starts with every kernel is in the kernel's own file, not a request after it", !!kernelFile && !apart.length, `a file of their own: ${apart.join(", ")}`);

  // A manifest the build doesn't understand stops it.
  const root = mkdtempSync(join(tmpdir(), "module-json-"));
  for (const name of ["bus", "llm"]) {
    mkdirSync(join(root, "std", name), { recursive: true });
    writeFileSync(join(root, "std", name, "module.ts"), "export default {};\n");
  }
  writeFileSync(join(root, "kernel.json"), JSON.stringify({ modules: ["bus", "llm"] }));
  const outcome = (bus, llm = { services: ["llm"] }) => {
    if (bus === undefined) rmSync(join(root, "std", "bus", "module.json"), { force: true });
    else writeFileSync(join(root, "std", "bus", "module.json"), JSON.stringify(bus));
    writeFileSync(join(root, "std", "llm", "module.json"), JSON.stringify(llm));
    try {
      moduleManifest("bus", root);
      return { ok: moduleManifests(root) };
    } catch (error) {
      return { error: error.message };
    }
  };
  const good = outcome({ services: ["bus"], hooks: ["bus:posted"], starts: "space" });
  const none = outcome(undefined);
  const unknown = outcome({ services: ["bus"], provides: ["bus"] });
  const notList = outcome({ services: "bus" });
  const badStart = outcome({ services: ["bus"], starts: "sometimes" });
  const badOnly = outcome({ services: ["bus"], only: "browser" });
  const twice = outcome({ services: ["llm"] });
  rmSync(root, { recursive: true, force: true });
  check("a kernel module's manifest says what it adds", good.ok?.bus?.hooks?.[0] === "bus:posted", JSON.stringify(good));
  check(
    "a module with no manifest, a manifest with a setting the kernel doesn't know or a wrong value, or two modules that add the same service, stops the build",
    /has no manifest/.test(none.error) && /isn't a setting/.test(unknown.error) && /must be a list/.test(notList.error) && /starts must be/.test(badStart.error) && /only must be "server"/.test(badOnly.error) && /both add llm/.test(twice.error),
    JSON.stringify({ none, unknown, notList, badStart, badOnly, twice }),
  );

  // A kernel of its own (another browser context has its own shared worker), so what other checks used doesn't count.
  const fresh = await context.browser().newContext();
  const page = await fresh.newPage();
  try {
    // A small app: its kernel runs the modules its plugins use, and no others.
    await page.goto(`${site}demos/habits/`);
    await page.waitForFunction(() => window.__host);
    const running = async () => (await page.evaluate(() => window.__host.command("modules"))).filter((m) => m.running).map((m) => m.name).sort();
    const settled = async () => {
      await page.waitForFunction(() => window.__host.traces.some((e) => e.name === "kernel:start"), null, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
    };
    await settled();
    const atStart = await running();
    // history starts with every kernel (its manifest says so): undo holds every write from the first.
    check("history starts with every kernel", atStart.includes("history"), `running at the start: ${atStart.join(", ") || "none"}`);
    // So a plugin that asks for history later, in an app whose plugins never listed it, can undo a write made before it asked.
    const log = (id, prefix) => page.waitForFunction(([i, p]) => window.__host.traces.findLast((e) => e.plugin === i && e.detail?.startsWith(p)), [id, prefix], { timeout: 5000 }).then((h) => h.jsonValue()).then((e) => e.detail).catch((e) => `no answer: ${e.message.split("\n")[0]}`);
    await page.evaluate((source) => window.__host.command("install", source), `export const manifest = { id: 'early-writer', name: 'Early writer', permissions: [], collections: { 'early-notes': { title: 'Early notes', schema: { type: 'object', properties: { title: { type: 'string' } } } } } };
export default async (ctx) => { await ctx.call('data', 'put', 'early-notes', { title: 'Written first' }); ctx.log('early-done'); };`);
    await log("early-writer", "early-done");
    await page.evaluate((source) => window.__host.command("install", source), `export const manifest = { id: 'late-undoer', name: 'Late undoer', permissions: ['history', 'data:read:early-notes'] };
export default async (ctx) => {
  const answer = await ctx.call('history', 'undo').catch((e) => ({ ok: false, error: e.message }));
  ctx.log('late-undo ' + JSON.stringify({ ok: answer.ok, by: answer.step?.by, text: answer.step?.text, error: answer.error, left: (await ctx.call('data', 'list', 'early-notes')).length }));
};`);
    const late = await log("late-undoer", "late-undo");
    check("a plugin that asks for history later, in an app that never listed it, undoes a write made before it asked", /"ok":true/.test(late) && /"by":"early-writer"/.test(late) && /"left":0/.test(late), late);
    for (const id of ["late-undoer", "early-writer"]) await page.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
    const unwanted = ["spaces", "maker", "game", "audio", "folder", "outside", "email", "transfer"].filter((name) => atStart.includes(name));
    check("an app's kernel starts only the modules its plugins use: Habits starts no spaces, app maker, game, audio, folder, email or MCP module", !unwanted.length && atStart.length < modules.length / 2, `running at the start: ${atStart.join(", ") || "none"}`);

    // A page command of a module starts it (debug's bench), and only it.
    const before = await running();
    const bench = await page.evaluate(() => window.__host.command("bench", 5));
    const afterBench = await running();
    check("running a module's command starts that module", bench?.n === 5 && afterBench.includes("debug") && afterBench.filter((n) => !before.includes(n)).every((n) => n === "debug"), JSON.stringify({ before, afterBench }));

    // Describing the whole kernel starts every module, and then every manifest must be true: nothing listed that was never added.
    const reference = await page.evaluate(() => window.__host.command("reference"));
    const state = await page.evaluate(() => window.__host.command("modules"));
    const stopped = state.filter((m) => !m.running).map((m) => m.name);
    check("the kernel's reference describes every module the site lists, so asking for it starts them all", !stopped.length && modules.filter((name) => !serverOnly.includes(name)).every((name) => state.some((m) => m.name === name)), `not running: ${stopped.join(", ")}`);
    // What a module adds only on a space's server (a door, the spaces module's server hooks) is checked there (tests/server/).
    const SERVER_ONLY = /^(doors |hooks sync:)/;
    const untrue = state.flatMap((m) => m.unused.filter((n) => !SERVER_ONLY.test(n)).map((n) => `${m.name}: ${n}`));
    check("no module's manifest lists a service, hook, command or message the module doesn't add", !untrue.length, untrue.join("; "));
    const services = new Set(reference.data.services.map((s) => s.name));
    const hooks = new Set(reference.data.hooks.map((h) => h.name));
    const manifests = moduleManifests(ROOT);
    const absent = Object.entries(manifests).flatMap(([name, m]) => [...(m.services ?? []).filter((s) => !services.has(s)), ...(m.hooks ?? []).filter((h) => !hooks.has(h) && !SERVER_ONLY.test(`hooks ${h}`))].map((n) => `${name}: ${n}`));
    check("every service and hook the manifests list is in the reference once the modules run", !absent.length, absent.join("; "));
    const empty = reference.data.services.filter((s) => !s.description || !s.methods.length).map((s) => s.name);
    check("the reference has every service's own description and methods, never a stand-in's", !empty.length, empty.join(", "));
  } finally {
    await fresh.close();
  }
}
