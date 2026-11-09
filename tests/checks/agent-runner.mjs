// The agent loop isn't part of the kernel (the architecture audit's finding 6):
// the standard loop is std/agents/runner.js, served like any std file, and an
// agent file may name another with `runner:`. The kernel makes the agent's
// plugin from the manifest, AGENT and whichever loop came with the file; an
// agent whose loop didn't load fails, and never runs the standard one instead.
import { watchErrors } from "../page-errors.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkApps } from "../../scripts/check.mjs";

export default async function ({ check, URL, context, errors }) {
  const [app] = await checkApps(["tests/fixtures/agent-runner-app"]);
  const problems = app.problems.map((p) => `${p.file}: ${p.message}`);
  check("npm run check reads an agent's own loop, named by runner:, next to the agent file", app.plugins.includes("planner") && !problems.some((p) => p.includes("planner")), problems.join("; "));
  check("an agent whose loop isn't there is an error, not the standard loop", problems.some((p) => p.includes("lost.agent.md") && p.includes("./not-here.js doesn't exist")), problems.join("; "));

  // In the browser: the standard loop is a file the site serves, and the kernel's bundle doesn't hold it.
  const served = await fetch(`${URL}std/agents/runner.js`).then((r) => (r.ok ? r.text() : ""), () => "");
  check("the standard agent loop is served at /std/agents/runner.js", served === readFileSync(new globalThis.URL("../../std/agents/runner.js", import.meta.url), "utf8"));
  // A sentence only the loop says, looked for in every built file but the served std/ copy.
  const sample = "had too much to do";
  const built = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? built(join(dir, e.name)) : [join(dir, e.name)]));
  const dist = fileURLToPath(new globalThis.URL("../../dist/", import.meta.url));
  const baked = built(dist).filter((f) => f.endsWith(".js") && !f.startsWith(join(dist, "std")) && readFileSync(f, "utf8").includes(sample));
  check("no built bundle carries the agent loop: it is only the served std/agents/runner.js", served.includes(sample) && !baked.length, baked.join(", "));

  // A loop of the app's choosing is still held to the agents service: called directly, llm.complete and
  // tools.call are refused for an agent, so its limits and agent:beforeTool can't be gone around. The
  // librarian's file is served here naming a loop that tries both (no service worker, so the page's own
  // requests can be rewritten).
  const own = await context.browser().newContext({ serviceWorkers: "block" });
  try {
    await own.route(`${URL}demos/librarian/librarian.agent.md`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("\nid: librarian\n", "\nid: librarian\nrunner: ./sneaky-loop.js\n") });
    });
    await own.route(`${URL}demos/librarian/sneaky-loop.js`, (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `export default async function (ctx) {
  const tried = async (service, method, ...args) => ctx.call(service, method, ...args).then(() => "allowed", (e) => "refused: " + e.message);
  ctx.log("sneaky llm " + (await tried("llm", "complete", { messages: [{ role: "user", content: "hi" }] })));
  ctx.log("sneaky tools " + (await tried("tools", "call", "data_list_library", {})));
  ctx.log("sneaky agents " + (await tried("agents", "next")));
}`,
      }),
    );
    const bench = await own.newPage();
    await bench.goto(`${URL}workbench/`);
    const page = await own.newPage();
    watchErrors(page, errors, "agent-runner");
    await page.goto(`${URL}demos/librarian/app.html`);
    const said = async (what) =>
      bench
        .waitForFunction((w) => window.__host?.traces.find((e) => e.plugin === "librarian" && e.detail?.startsWith(`sneaky ${w} `))?.detail, what, { timeout: 10000 })
        .then((h) => h.jsonValue(), () => "");
    const llm = await said("llm");
    const tools = await said("tools");
    const agents = await said("agents");
    check("an agent's own loop can't call llm.complete or tools.call around the agents service", llm.includes("refused: An agent calls llm.complete through the agents service") && tools.includes("refused: An agent calls tools.call through the agents service"), JSON.stringify({ llm, tools }));
    check("an agent's own loop runs, and reaches the agents service as the standard loop does", agents === "sneaky agents allowed", agents);
  } finally {
    await own.close();
  }
}
