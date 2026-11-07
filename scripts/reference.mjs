// Writes docs/api.md from the running kernel: builds are served with
// `vite preview`, a headless Chromium opens the app, and the kernel prints
// its own reference. The tests fail when docs/api.md falls behind.
//
//   npm run reference

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PORT = 4174;
const server = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
try {
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => String(d).includes(String(PORT)) && resolve());
    server.on("exit", (code) => reject(new Error(`vite preview exited with ${code}`)));
    setTimeout(resolve, 5000);
  });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // The workbench: the homepage is an app, and its collections would join the reference.
  await page.goto(`http://localhost:${PORT}/workbench/`);
  await page.waitForFunction(() => window.__host);
  const { markdown } = await page.evaluate(() => window.__host.command("reference"));
  writeFileSync(new URL("../docs/api.md", import.meta.url), markdown);
  console.log(`Wrote docs/api.md (${markdown.split("\n").length} lines)`);
  await browser.close();
} finally {
  server.kill();
}
process.exit(0);
