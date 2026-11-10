// A project of its own (scripts/extensible-app.mjs) picks its kernel's
// modules and hook limits with a kernel.json at its top, and its links to its
// own screens move there with the History API.
//
// The project has the platform as a dependency and builds no kernel, so its
// kernel.json is written into its own copies of the platform's built kernels
// (scripts/project-kernel.mjs): the browser's, Node's (for `dev`'s spaces) and
// Cloudflare's (for the deployed Worker's). Each then runs only the modules
// listed. A kernel.json that can't be used stops the command.
//
// An app at the root shares it with the site's own pages (/account/), so a
// link there is asked about first (src/host/root-screens.ts): a screen is moved
// to without loading the page, and a page of the site's is loaded.
import { watchErrors } from "../page-errors.mjs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MessageChannel, Worker } from "node:worker_threads";
import { makeProject } from "../../scripts/create-app.mjs";
import { check as checkProject, dev, layoutProject } from "../../scripts/extensible-app.mjs";
import { projectKernel, stamp } from "../../scripts/project-kernel.mjs";
import { STAMP } from "../../vite.kernel-modules.ts";

/** Asks a server kernel (a built space.js) which modules it runs, as a client would. */
function serverModules(kernel, dir) {
  return new Promise((done, failed) => {
    const worker = new Worker(kernel, { workerData: { dir, origin: "http://localhost", allowPrivate: [], email: false } });
    const timer = setTimeout(() => finish(failed, new Error("the kernel didn't answer")), 15000);
    const finish = (settle, value) => {
      clearTimeout(timer);
      void worker.terminate();
      settle(value);
    };
    worker.on("error", (error) => finish(failed, error));
    worker.on("message", (message) => {
      if (message?.t !== "ready") return;
      const { port1, port2 } = new MessageChannel();
      port1.on("message", (reply) => reply?.t === "command:result" && finish(done, reply.value));
      worker.postMessage({ t: "connect", port: port2 }, [port2]);
      port1.postMessage({ t: "hello", tab: "check" });
      port1.postMessage({ t: "command", id: 1, name: "modules" });
    });
  });
}

export default async function ({ check, context, errors }) {
  const built = readdirSync("dist/assets").filter((name) => /^browser-.*\.js$/.test(name));
  const marks = (text) => text.split(STAMP).length - 1;
  check(
    "every built kernel has one place for a project's kernel.json, and none written there",
    built.length === 1 &&
      [join("dist/assets", built[0] ?? ""), ".build/server/space.js", ".build/cloudflare/kernel-source.js"].every((file) => existsSync(file) && marks(readFileSync(file, "utf8")) === 1 && !new RegExp(`${STAMP}[A-Za-z0-9+/]`).test(readFileSync(file, "utf8"))),
    built.join(", "),
  );

  const thrown = (fn) => {
    try {
      fn();
      return "";
    } catch (error) {
      return error.message;
    }
  };
  const settings = { modules: ["router"] };
  const once = stamp(`a="${STAMP}";`, settings, STAMP, "x");
  const twice = stamp(once, { modules: ["debug", "router"], hooks: { max: 3 } }, STAMP, "x");
  const read = (text) => JSON.parse(atob(new RegExp(`${STAMP}([A-Za-z0-9+/]*)`).exec(text)[1]));
  check("a kernel.json is written after the mark, and written again over the last one", read(once).modules.join() === "router" && read(twice).hooks.max === 3 && twice.endsWith('";') && marks(twice) === 1, twice);
  check("a kernel with no mark, or more than one, is never written to", /no place/.test(thrown(() => stamp("a=1", settings, STAMP, "x"))) && /2 places/.test(thrown(() => stamp(`${STAMP} ${STAMP}`, settings, STAMP, "x"))));

  const scratch = mkdtempSync(join(tmpdir(), "project-kernel-"));
  let server;
  try {
    const folder = join(scratch, "packing-list");
    makeProject(folder, { name: "Packing list", platform: `file:${resolve(".")}` });
    check("a project with no kernel.json runs the platform's kernels as they are", projectKernel(folder) === undefined && !existsSync(join(layoutProject(folder).target, "platform")));

    const kernelJson = (json) => writeFileSync(join(folder, "kernel.json"), typeof json === "string" ? json : JSON.stringify(json));
    const refused = (json) => (kernelJson(json), thrown(() => projectKernel(folder)));
    const unknownModule = refused({ modules: ["router", "teleport"] });
    const unknownSetting = refused({ modules: ["router"], plugins: [] });
    const unknownLimit = refused({ modules: ["router"], hooks: { timeoutSeconds: 10 } });
    const noModules = refused({ hooks: { max: 3 } });
    check(
      "a project's kernel.json with a module the platform hasn't got, a setting or limit it doesn't know, or no modules, stops the command",
      /lists teleport, which isn't one of the platform's kernel modules/.test(unknownModule) && /isn't a setting/.test(unknownSetting) && /isn't a limit/.test(unknownLimit) && /needs a `modules` list/.test(noModules),
      JSON.stringify({ unknownModule, unknownSetting, unknownLimit, noModules }),
    );
    kernelJson({ modules: ["router", "teleport"] });
    const devRefused = await dev(folder, { port: 0, quiet: true }).then((s) => s.stop().then(() => ""), (error) => error.message);
    const checkRefused = await checkProject(folder).then(() => "", (error) => error.message);
    check("extensible-app dev, check and deploy all refuse a kernel.json that can't be used", /teleport/.test(devRefused) && /teleport/.test(checkRefused) && /teleport/.test(thrown(() => layoutProject(folder))), `${devRefused} | ${checkRefused}`);

    // The project picks two modules and a hook limit. Its page links to a screen of its own and to a page of the site's.
    kernelJson({ modules: ["debug", "router"], hooks: { max: 3 } });
    const page = readFileSync(join(folder, "app.html"), "utf8");
    writeFileSync(join(folder, "app.html"), page.replace("</header>", '  <nav><a id="to-book" href="/book/42?tab=notes">A book</a> <a id="to-home" href="/">Home</a> <a id="to-account" href="/account/">Account</a></nav>\n  </header>'));
    const plugin = readFileSync(join(folder, "main.js"), "utf8");
    const fine = await checkProject(folder);
    check("extensible-app check passes the project with its own kernel.json", !fine.problems.some((p) => p.level === "error"), JSON.stringify(fine.problems));
    writeFileSync(join(folder, "main.js"), plugin.replace("export default async function (ctx) {", 'export default async function (ctx) {\n  await ctx.call("bus", "publish", "x", 1);'));
    const called = await checkProject(folder);
    writeFileSync(join(folder, "main.js"), plugin);
    check("extensible-app check says a service of a module the project left out isn't there", called.problems.some((p) => p.level === "error" && /there is no bus service on this site/.test(p.message)), JSON.stringify(called.problems));
    writeFileSync(join(folder, "main.js"), plugin.replace('permissions: ["ui"]', 'permissions: ["ui", "schedule"]').replace("export default async function (ctx) {", 'export default async function (ctx) {\n  ctx.schedule.every("tidy", 60, () => {});'));
    const scheduled = await checkProject(folder);
    writeFileSync(join(folder, "main.js"), plugin);
    check("and says so of a shorthand for one (ctx.schedule.every)", scheduled.problems.some((p) => p.level === "error" && /ctx\.schedule\.every uses the schedule service, and there is no schedule service on this site/.test(p.message)), JSON.stringify(scheduled.problems));

    const laid = layoutProject(folder);
    const deployed = JSON.parse(readFileSync(laid.config, "utf8").replace(/^\/\/.*$/gm, ""));
    const source = (file) => JSON.parse(/export default (\{[^]*\});\n$/.exec(readFileSync(file, "utf8"))[1]);
    const theirs = source(".build/cloudflare/kernel-source.js");
    const ours = existsSync(join(laid.target, "platform/.build/cloudflare/kernel-source.js")) ? source(join(laid.target, "platform/.build/cloudflare/kernel-source.js")) : { modules: {} };
    check(
      "extensible-app deploy gives the Worker a copy of the platform's kernel with the project's kernel.json in it, under a version of its own",
      deployed.main === "platform/src/server/cloudflare/worker.ts" && existsSync(join(laid.target, deployed.main)) && ours.version !== theirs.version && /^[0-9a-f]{12}$/.test(ours.version ?? "") && read(JSON.stringify(ours.modules)).modules.join() === "debug,router" && marks(JSON.stringify(ours.modules)) === 1,
      `${deployed.main} ${ours.version} ${theirs.version}`,
    );
    const sent = readFileSync(join(laid.site, "_headers"), "utf8");
    check("a site with a kernel.json of its own has browsers check /assets/ each time, since its kernel changes with that file", /^\/assets\/\*\n\s+Cache-Control: public, max-age=0, must-revalidate$/m.test(sent) && !/immutable/.test(sent) && /immutable/.test(readFileSync("dist/_headers", "utf8")) && sent.includes("/assets/runtime-*"), sent.slice(0, 400));
    check("the deployed site's browser kernel has it too, and kernel.json itself isn't served", read(readFileSync(join(laid.site, "assets", built[0]), "utf8")).hooks.max === 3 && !existsSync(join(laid.site, "kernel.json")));
    check("the platform's own kernels are left as they were", marks(readFileSync(join("dist/assets", built[0]), "utf8")) === 1 && !new RegExp(`${STAMP}[A-Za-z0-9+/]`).test(readFileSync(join("dist/assets", built[0]), "utf8") + readFileSync(".build/cloudflare/kernel-source.js", "utf8") + readFileSync(".build/server/space.js", "utf8")));

    server = await dev(folder, { port: 0, quiet: true });
    const spaces = await serverModules(join(folder, ".extensible", "server", "space.js"), join(scratch, "space")).catch((error) => error.message);
    check("the project's kernel for spaces, on Node, runs only the modules its kernel.json lists", Array.isArray(spaces) && spaces.map((m) => m.name).sort().join() === "debug,router", JSON.stringify(spaces).slice(0, 300));

    const own = await context.browser().newContext();
    const tab = await own.newPage();
    watchErrors(tab, errors, "project-kernel");
    await tab.goto(server.url);
    const drawn = await tab.waitForSelector('slot[name="main"] ui-form', { timeout: 15000 }).then(() => true, () => false);
    const modules = drawn ? await tab.evaluate(() => window.__host.command("modules")) : [];
    check("the project's kernel in the browser knows only the modules its kernel.json lists, and the app runs", drawn && modules.map((m) => m.name).sort().join() === "debug,router", JSON.stringify(modules));
    const limits = drawn ? JSON.stringify(await tab.evaluate(() => window.__host.command("reference"))) : "";
    check("the project's kernel uses its hook limits", /at most 3 hooks/.test(limits) || /\b3\b[^.]{0,40}hooks/.test(limits), limits.match(/[^.]*kernel\.json's `hooks`[^.]*\./)?.[0] ?? limits.slice(0, 200));
    check("a project doesn't serve its kernel.json", (await tab.evaluate(async () => (await fetch("/kernel.json")).status)) === 404);

    // Links: a screen of the app without loading the page; back; and one of the site's own pages, loaded.
    check("the project's front page says it is an app at the root", await tab.evaluate(() => document.querySelector("base")?.getAttribute("href") === "/"));
    // The service worker says which addresses are screens; before it runs the page, a link just loads.
    await tab.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
    await tab.evaluate(() => void (window.__sameLoad = true));
    await tab.click("#to-book");
    const moved = await tab.waitForFunction(() => location.pathname === "/book/42", null, { timeout: 8000 }).then(() => true, () => false);
    check("a link to a screen of an app at the root moves there with the History API, without loading the page", moved && (await tab.evaluate(() => window.__sameLoad === true && location.search === "?tab=notes")), await tab.evaluate(() => location.href));
    const asked = await tab.evaluate(() =>
      Promise.all(
        ["/book/7", "/apps/reading-list/", "/s/some-space/book/7", "/user/x/y", "/account/"].map(
          (address) =>
            new Promise((answer) => {
              const { port1, port2 } = new MessageChannel();
              port1.onmessage = (event) => answer(event.data);
              navigator.serviceWorker.controller.postMessage({ t: "sw:screen", url: new URL(address, location.href).href }, [port2]);
            }),
        ),
      ),
    );
    check("the service worker says an address is the root app's screen only where no other route or page answers it (/apps/, /s/, /user/, /account/)", asked.join() === "true,false,false,false,false", asked.join());
    const kernelCache = await tab.evaluate(async (file) => (await fetch(`/assets/${file}`)).headers.get("Cache-Control"), built[0]);
    check("extensible-app dev sends the project's kernel to be checked each time, not kept for a year", /must-revalidate/.test(kernelCache ?? "") && !/immutable/.test(kernelCache ?? ""), String(kernelCache));
    const screen = await tab.evaluate(() => window.__host.command("modules")).then((m) => m.find((x) => x.name === "router"));
    check("the kernel hears the screen the tab moved to", !!screen, JSON.stringify(screen));
    await tab.click("#to-home");
    const home = await tab.waitForFunction(() => location.pathname === "/", null, { timeout: 8000 }).then(() => true, () => false);
    await tab.goBack();
    const back = await tab.waitForFunction(() => location.pathname === "/book/42", null, { timeout: 8000 }).then(() => true, () => false);
    check("a link home, and back, move between the app's screens in the same page", home && back && (await tab.evaluate(() => window.__sameLoad === true)));
    await tab.reload();
    const reopened = await tab.waitForSelector('slot[name="main"] ui-form', { timeout: 15000 }).then(() => true, () => false);
    await tab.evaluate(() => void (window.__sameLoad = true));
    await tab.click("#to-account");
    const loaded = await tab.waitForFunction(() => location.pathname === "/account/" && window.__sameLoad !== true, null, { timeout: 15000 }).then(() => true, () => false);
    check("a link from a screen to one of the site's own pages (/account/) loads that page", reopened && loaded && (await tab.title()) !== "Packing list", `${reopened} ${loaded} ${await tab.title()} ${await tab.evaluate(() => location.href)}`);
    await own.close();
  } finally {
    await server?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
}
