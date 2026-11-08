// The account page's email field (account/index.html): someone signed in gives
// the address their spaces' apps may email them at, sees it kept, and can take
// it away. The email service mails only these (tests/server/run.mjs checks that).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

export default async function ({ check, context, errors }) {
  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "account-email-"));
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await phone.newPage();
    page.on("pageerror", (e) => errors.push(`account-email: ${e.message}`));
    const cdp = await phone.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    await page.goto(`${server.url}/account/`);
    await page.fill("#name", "Robin");
    await page.click('#register button[type="submit"]');
    await page.waitForSelector("#in:not([hidden])", { timeout: 8000 });

    await page.fill("#email-address", "robin@example.com");
    await page.click('#email button[type="submit"]');
    const said = await page.locator("#status").filter({ hasText: "saved" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    await page.reload();
    await page.waitForSelector("#in:not([hidden])", { timeout: 8000 });
    const kept = await page.inputValue("#email-address");

    await page.fill("#email-address", "");
    await page.click('#email button[type="submit"]');
    await page.locator("#status").filter({ hasText: "saved" }).waitFor({ timeout: 5000 }).catch(() => {});
    const me = await page.evaluate(() => fetch("/auth/me").then((r) => r.json()));
    check("account email: the account page keeps the address your spaces' apps may email, and an empty one takes it away", said && kept === "robin@example.com" && me.user && !("email" in me.user), JSON.stringify({ said, kept, me }));
  } finally {
    await phone.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true });
  }
}
