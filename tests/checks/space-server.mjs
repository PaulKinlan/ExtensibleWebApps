// The hosts' checks (tests/server/run.mjs, Node and Cloudflare) run in Node, not the browser: this builds the space
// kernel and runs them as part of the main test run, so a broken server fails `npm test` too.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default async function ({ check }) {
  const build = spawnSync("npm", ["run", "-s", "build:server"], { encoding: "utf8", timeout: 120_000 });
  const run = build.status === 0 ? spawnSync(process.execPath, ["--no-warnings", fileURLToPath(new URL("../server/run.mjs", import.meta.url))], { encoding: "utf8", timeout: 300_000 }) : build;
  const lines = (run.stdout ?? "").split("\n").filter((l) => /^(PASS|FAIL) {2}/.test(l));
  const failed = lines.filter((l) => l.startsWith("FAIL"));
  check("a space's kernel runs on Node and on Cloudflare (wrangler dev), behind a WebSocket, and keeps its folder", run.status === 0 && lines.length > 0 && !failed.length, failed.length ? failed.join("; ") : `${lines.length} checks${run.stderr ? `; ${run.stderr.slice(0, 300)}` : ""}`);
}
