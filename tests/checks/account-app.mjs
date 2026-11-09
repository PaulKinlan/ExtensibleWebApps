// The account page is an app (account/app.html): its plugins ask the server
// through the `account` service (std/account/module.ts), which only the
// account app's own plugins may use. A person's plugin that asks for it is
// refused, in the account app as in any other. And a new agent key shows the
// MCP address of the app the person names, not always the reading list's.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

export default async function ({ check, context, errors }) {
  // npm run check looks at demos/ by default; the account app is checked here, the same way.
  let checked = "";
  try {
    checked = execFileSync(process.execPath, ["scripts/check.mjs", "account"], { cwd: new URL("../../", import.meta.url), encoding: "utf8" });
  } catch (error) {
    checked = `${error.stdout ?? ""}${error.message}`;
  }
  check("npm run check finds nothing wrong with the account app", /^0 errors, 0 warnings$/m.test(checked), checked.trim().split("\n").slice(-4).join(" | "));

  const spaces = await mkdtemp(join(tmpdir(), "account-app-"));
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" });
  const own = await context.browser().newContext();
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(`account-app: ${e.message}`));
  try {
    const cdp = await own.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    await page.goto(`${server.url}/account/`);
    await page.fill('form[data-action="register"] input[name="name"]', "Ada");
    await page.click('form[data-action="register"] button[type="submit"]');
    await page.waitForSelector(".signed-in", { timeout: 8000 });

    // A person's own plugin in the account app, asking who is signed in.
    const command = (name, arg) => page.evaluate(([name, arg]) => window.__host.command(name, arg), [name, { app: "account", ...arg }]);
    const theirs =
      'export const manifest = { id: "peek", name: "Peek", permissions: ["ui", "account"], services: ["account"] };\n' +
      'export default async (ctx) => { const said = await ctx.call("account", "get", "/auth/me").then((me) => `saw ${me.user?.name}`, (e) => `refused: ${e.message}`); ctx.ui.render("main", "peek", ctx.ui.html`<p class="peek">${said}</p>`); };\n';
    await command("user:add", { files: [{ name: "peek.js", data: theirs }] });
    await command("user:on", { id: "peek" });
    const peek = await page.locator(".peek").textContent({ timeout: 10000 }).catch(() => "");
    check("a person's own plugin can't use the account service, even in the account app", /^refused: Only the account app's own plugins/.test(peek ?? ""), peek);
    await command("user:remove", { id: "peek" }).catch(() => {});

    await page.fill('form[data-action="make"] input[name="name"]', "ada-home");
    await page.click('form[data-action="make"] button[type="submit"]');
    const keyForm = page.locator('.keys form[data-action="make"]');
    await keyForm.waitFor({ timeout: 8000 }).catch(() => {});
    await keyForm.locator('input[name="name"]').fill("Claude Code");
    await keyForm.locator('input[name="door"]').fill("survey-agents");
    await keyForm.locator('button[type="submit"]').click();
    const named = await page.locator(".keys .made input").nth(2).inputValue({ timeout: 8000 }).catch(() => "");
    await keyForm.locator('input[name="name"]').fill("Another agent");
    await keyForm.locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelectorAll(".keys .key-list li").length >= 2, null, { timeout: 8000 }).catch(() => {});
    const unnamed = await page.locator(".keys .made input").nth(2).inputValue().catch(() => "");
    check(
      "a new agent key shows the MCP address of the app named for it, and a placeholder when none is, never the reading list's",
      named.includes(`${server.url}/s/ada-home/mcp/survey-agents`) && named.includes("Bearer ") && unnamed.includes("/s/ada-home/mcp/<plugin>") && !/reading-list/.test(named + unnamed),
      JSON.stringify({ named, unnamed }),
    );

    // Coming back from signing in with another site, the address has no ?app= and the referrer is that site:
    // the tab keeps the app it was opened for.
    const surveys = '.space-list a:has-text("Open Surveys in it")';
    await page.goto(`${server.url}/account/?app=/demos/survey/`);
    const offered = await page.locator(surveys).waitFor({ timeout: 8000 }).then(() => true, () => false);
    await page.goto(`${server.url}/account/`);
    const kept = await page.locator(surveys).waitFor({ timeout: 8000 }).then(() => true, () => false);
    check("the account page keeps the app it was opened for, in that tab, when it comes back without ?app= (from another site's sign-in)", offered && kept, JSON.stringify({ offered, kept }));
  } finally {
    await own.close();
    await server.stop();
    await rm(spaces, { recursive: true, force: true });
  }
}
