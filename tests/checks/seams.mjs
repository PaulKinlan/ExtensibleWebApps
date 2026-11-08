// The server seams' conformance checks (tests/seams/run.mjs) run in Node, not the browser: this runs
// them as part of the main test run and reports each one, so a broken provider fails `npm test` too.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default async function ({ check }) {
  const run = spawnSync(process.execPath, ["--no-warnings", fileURLToPath(new URL("../seams/run.mjs", import.meta.url))], { encoding: "utf8", timeout: 60_000 });
  const lines = (run.stdout ?? "").split("\n").filter((l) => /^(PASS|FAIL) {2}/.test(l));
  const failed = lines.filter((l) => l.startsWith("FAIL"));
  check("every seam provider passes the conformance checks", run.status === 0 && lines.length > 0 && !failed.length, failed.length ? failed.join("; ") : `${lines.length} checks${run.stderr ? `; ${run.stderr.slice(0, 300)}` : ""}`);
}
