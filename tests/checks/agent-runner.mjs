// The agent loop isn't part of the kernel (the architecture audit's finding 6):
// the standard loop is std/agents/runner.js, served like any std file, and an
// agent file may name another with `runner:`. The kernel makes the agent's
// plugin from the manifest, AGENT and whichever loop came with the file; an
// agent whose loop didn't load fails, and never runs the standard one instead.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkApps } from "../../scripts/check.mjs";

export default async function ({ check, URL }) {
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
}
