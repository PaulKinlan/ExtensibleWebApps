// Reloading a plugin leaves nothing behind (the plan's phase 1 test).
//
// A plugin is reloaded every time its code changes: when a person edits one in the plugin editor, when an agent
// rewrites one, when a module restarts under it. Each reload stops its worker and starts another, and everything
// the old one added has to go with it: its listeners, the hooks it defined, the service it provided, its
// commands, routes and scheduled jobs, its views in the page. One of these left behind each time is nothing
// anyone sees, until the hundredth edit of a long session.
//
// So a plugin that adds one of everything is reloaded a hundred times, and three things are compared before
// and after:
//
//   - what the kernel keeps: every list, map and set reachable from its parts, counted by where it is kept
//     (the `counts` command, std/debug/module.ts), so a number that grew names what was left
//   - what the page keeps: its plugin workers, its nodes and its event listeners, as the browser counts them
//   - memory, after a collection: the kernel's heap and the page's may grow by no more than the bound below
//
// It runs on the workbench, the one page that shows every plugin's views, with the kernel in a worker of the
// page's own (?kernel=dedicated), whose heap the browser's debugger can read.
import { watchErrors } from "../page-errors.mjs";

const RELOADS = 100;
/** Reloads before the first count: what fills once and stays (the trace's ring, the caches of compiled code) has filled. */
const WARM_UP = 30;
/**
 * The most either heap may grow over the hundred reloads: 5 KB a reload. A worker, a view or a port kept each time is
 * more. What does grow, measured over 600 reloads with heap snapshots of the kernel 300 reloads apart:
 *   - the kernel by about 140 KB in the first hundred and 50 KB a hundred after, all of it code the engine compiled
 *     as the reload path got hot (not one object of the kernel's own was added)
 *   - the page by about 370 KB a hundred, which is the trace it keeps for the debugger: 19 events a reload until it
 *     holds its 7,000, and nothing after that (12 KB over the sixth hundred)
 */
const HEAP_BOUND = 500_000;

const PROBE = `export const manifest = {
  id: "leak-probe",
  name: "Leak probe",
  version: "1.0.0",
  permissions: ["ui", "storage", "routes", "schedule", "provide:leak-echo", "hook:listen:data:changed:leak-notes"],
  services: ["commands", "schedule"],
  collections: { "leak-notes": { title: "Leak notes", schema: { type: "object", properties: { text: { type: "string", title: "Text" } } } } },
  hooks: { tick: { mode: "emit", description: "Nothing." } },
  provides: { "leak-echo": { description: "Says it back.", methods: { say: { args: "(text)", description: "The text." } } } },
};
export default async function (ctx) {
  ctx.on("data:changed:leak-notes", () => {});
  ctx.on("leak-probe:tick", () => {});
  ctx.on("leak-probe:tick", () => {});
  ctx.commands.add({ id: "leak-probe-hello", title: "Say hello" }, () => "hello");
  ctx.routes.add("GET", "leak-probe", () => ({ body: "ok" }));
  ctx.schedule.every("leak-beat", 3_600_000, () => {});
  ctx.provide("leak-echo", { say: (text) => text });
  ctx.ui.onEvent(() => {});
  await ctx.call("data", "put", "leak-notes", { id: "one", text: "kept" });
  await ctx.call("storage", "set", "seen", Date.now());
  await ctx.hooks.emit("tick", 1);
  ctx.ui.render("side", "probe", { type: "html", html: '<form data-action="go"><label>Probe <input name="a" data-action="typed"></label><button>Go</button><ui-card><p>In a card</p></ui-card></form>' });
  ctx.ui.render("side", "probe-two", { type: "text", text: "leak-probe is up" });
  ctx.log("leak-probe up");
}
`;

export default async function ({ check, context, URL, errors }) {
  // A browser of its own: collecting garbage on demand, and exact heap sizes, are switches a browser starts with.
  const browser = await context.browser().browserType().launch({ args: ["--js-flags=--expose-gc"] });
  try {
    const own = await browser.newContext();
    const page = await own.newPage();
    watchErrors(page, errors, "hot-reload-leak");
    // The debugger, attached to the page and to each worker it starts: the kernel's is the one asked.
    const cdp = await own.newCDPSession(page);
    const attached = [];
    const answers = new Map();
    cdp.on("Target.attachedToTarget", (event) => attached.push(event));
    cdp.on("Target.receivedMessageFromTarget", (event) => {
      const message = JSON.parse(event.message);
      answers.get(message.id)?.(message.result);
      answers.delete(message.id);
    });
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
    await cdp.send("Performance.enable");
    let asked = 0;
    /** Asks the kernel's worker through the debugger; undefined if it doesn't answer. */
    const askKernel = (method) => {
      const sessionId = attached.find((event) => event.targetInfo.type === "worker" && /\/browser-|\/kernel\/browser/.test(event.targetInfo.url))?.sessionId;
      if (!sessionId) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        const id = ++asked;
        answers.set(id, resolve);
        cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method }) }).catch(() => resolve(undefined));
        setTimeout(() => resolve(undefined), 5000);
      });
    };
    await page.goto(`${URL}workbench/?kernel=dedicated`);
    await page.waitForFunction(() => window.__host?.workers.size >= 11, null, { timeout: 15000 });

    const installed = await page.evaluate((source) => window.__host.command("install", source), PROBE);
    /** The trace's number for the last time the probe said it was up; 0 if it hasn't. (By number, not by counting: the page keeps only so much of a long trace.) */
    const lastUp = () => page.evaluate(() => window.__host.traces.findLast((e) => e.plugin?.startsWith("leak-probe") && e.detail === "leak-probe up")?.seq ?? 0);
    /** Waits until the probe says it is up again, after trace event `since`; its number, or 0 if it doesn't. */
    const upAfter = async (since) => {
      for (let waited = 0; waited < 10000; waited += 20) {
        const seq = await lastUp();
        if (seq > since) return seq;
        await page.waitForTimeout(20);
      }
      return 0;
    };
    let seen = await upAfter(0);
    const started = seen > 0;
    const shown = await page.waitForSelector('[data-key="leak-probe:probe"] ui-card', { state: "attached", timeout: 8000 }).then(() => true, () => false);
    check("a plugin that adds one of everything (listeners, a hook, a service, a command, a route, a job, views) starts, and its views are on the page", installed?.ok !== false && started && shown, JSON.stringify(installed));
    if (!started) return;

    /** Everything counted, after a collection in the kernel and the page. */
    const measure = async () => {
      // Twice, a moment apart: what a first collection frees can free more (a worker's port, then what it held).
      for (let i = 0; i < 2; i++) {
        await askKernel("HeapProfiler.collectGarbage");
        await page.evaluate(() => globalThis.gc?.());
        await cdp.send("HeapProfiler.collectGarbage");
        await page.waitForTimeout(150);
      }
      const counts = await page.evaluate(() => window.__host.command("counts"));
      const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
      const heap = (await askKernel("Runtime.getHeapUsage"))?.usedSize;
      return {
        counts,
        kernelHeap: heap,
        pageHeap: metrics.JSHeapUsedSize,
        nodes: metrics.Nodes,
        listeners: metrics.JSEventListeners,
        workers: page.workers().length,
        counted: Object.keys(counts ?? {}).length,
        hostWorkers: await page.evaluate(() => window.__host.workers.size),
        views: await page.evaluate(() => document.querySelectorAll("[data-key]").length),
        styles: await page.evaluate(() => document.querySelectorAll("style").length + document.adoptedStyleSheets.length),
      };
    };
    /** Reloads the probe `n` times, each once the one before is up. Returns how many didn't come back. */
    const reload = async (n) => {
      let failed = 0;
      for (let i = 0; i < n; i++) {
        const ok = await page.evaluate(() => window.__host.command("reload", "leak-probe"));
        const seq = ok ? await upAfter(seen) : 0;
        if (seq) seen = seq;
        else failed++;
      }
      return failed;
    };

    const warm = await reload(WARM_UP);
    const before = await measure();
    const failed = await reload(RELOADS);
    const after = await measure();
    check(`the plugin comes back from each of ${RELOADS} reloads`, warm === 0 && failed === 0, `${warm} of the first ${WARM_UP} and ${failed} of the ${RELOADS} didn't`);

    const grew = Object.keys(after.counts ?? {})
      .filter((key) => (after.counts[key] ?? 0) > (before.counts?.[key] ?? 0))
      .map((key) => `${key}: ${before.counts?.[key] ?? 0} → ${after.counts[key]}`);
    check(
      `after ${RELOADS} reloads the kernel keeps what it kept before: every listener, hook, service, running plugin and view it counts`,
      before.counts && Object.keys(before.counts).length > 20 && before.counts["cordis.listeners"] > 0 && before.counts["remote.live"] > 0 && !grew.length,
      grew.length ? `left behind: ${grew.slice(0, 12).join("; ")}` : `counted ${Object.keys(before.counts ?? {}).length} collections`,
    );
    check(
      "and the page: as many plugin workers, views, styles, nodes and event listeners as before",
      after.workers === before.workers && after.hostWorkers === before.hostWorkers && after.views === before.views && after.styles === before.styles && after.nodes <= before.nodes + 20 && after.listeners <= before.listeners + 5,
      ["workers", "hostWorkers", "views", "styles", "nodes", "listeners"].map((k) => `${k} ${before[k]} → ${after[k]}`).join(", "),
    );
    const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
    check(
      `memory stays within ${kb(HEAP_BOUND)} over ${RELOADS} reloads, in the kernel and in the page`,
      typeof before.kernelHeap === "number" && after.kernelHeap - before.kernelHeap < HEAP_BOUND && after.pageHeap - before.pageHeap < HEAP_BOUND,
      `kernel ${kb(before.kernelHeap ?? 0)} → ${kb(after.kernelHeap ?? 0)}, page ${kb(before.pageHeap)} → ${kb(after.pageHeap)}`,
    );
    await page.evaluate(() => window.__host.command("uninstall", "leak-probe")).catch(() => {});
  } finally {
    await browser.close();
  }
}
