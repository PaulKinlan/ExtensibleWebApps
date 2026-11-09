// kernel.json is the site's: its modules, and the limits on hooks plugins
// define. The build reads it (vite.kernel-modules.ts), and a setting it
// doesn't know, or a limit that isn't a whole number above 0, stops the
// build rather than being ignored. The kernel uses the limits it sets.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookLimits, listedModules } from "../../vite.kernel-modules.ts";

export default async function ({ check, openTab }) {
  const root = mkdtempSync(join(tmpdir(), "kernel-json-"));
  mkdirSync(join(root, "std", "bus"), { recursive: true });
  writeFileSync(join(root, "std", "bus", "module.ts"), "export default {};\n");
  const outcome = (json) => {
    writeFileSync(join(root, "kernel.json"), JSON.stringify(json));
    try {
      return { modules: listedModules(root), limits: hookLimits(root) };
    } catch (error) {
      return { error: error.message };
    }
  };
  const plain = outcome({ modules: ["bus"] });
  const set = outcome({ modules: ["bus"], hooks: { timeoutMs: 10000, agentTimeoutMs: 60000 } });
  const unknownSetting = outcome({ modules: ["bus"], plugins: [] });
  const unknownLimit = outcome({ modules: ["bus"], hooks: { timeoutSeconds: 10 } });
  const notWhole = outcome({ modules: ["bus"], hooks: { timeoutMs: 2.5 } });
  const zero = outcome({ modules: ["bus"], hooks: { max: 0 } });
  const backwards = outcome({ modules: ["bus"], hooks: { defaultTimeoutMs: 9000, timeoutMs: 5000 } });
  rmSync(root, { recursive: true, force: true });
  check("kernel.json: with no hooks, every hook limit is the platform's default", JSON.stringify(plain.limits) === "{}" && plain.modules?.[0] === "bus", JSON.stringify(plain));
  check("kernel.json: a site sets hook limits beside its modules", set.limits?.timeoutMs === 10000 && set.limits.agentTimeoutMs === 60000, JSON.stringify(set));
  check(
    "kernel.json: a setting or limit it doesn't know, a limit that isn't a whole number above 0, or a default over the most, stops the build",
    /isn't a setting/.test(unknownSetting.error) && /isn't a limit/.test(unknownLimit.error) && /whole number/.test(notWhole.error) && /whole number/.test(zero.error) && /can't be more/.test(backwards.error),
    JSON.stringify({ unknownSetting, unknownLimit, notWhole, zero, backwards }),
  );

  // This site's kernel.json sets none, so a running kernel describes the defaults.
  const page = await openTab();
  const reference = await page.evaluate(() => window.__host.command("reference"));
  await page.close();
  const text = JSON.stringify(reference ?? "");
  check("the kernel's reference says a site may change the hook limits in kernel.json", /kernel\.json's `hooks`/.test(text), text.slice(0, 120));
}
