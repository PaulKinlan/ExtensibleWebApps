// Signing in with a passkey in a real browser: the account page (/account/) on
// the Node host, with Chromium's virtual authenticator standing in for a
// phone or a laptop's fingerprint reader. tests/server/run.mjs checks the
// server's side in more detail, on both hosts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

export default async function ({ check, context, errors }) {
  const spaces = await mkdtemp(join(tmpdir(), "signin-"));
  // Passkeys need a secure context: localhost counts, an IP address doesn't.
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" });
  const own = await context.browser().newContext();
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const cdp = await own.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    const status = () => page.locator("#status").textContent();
    await page.goto(`${server.url}/account/`);
    await page.fill("#name", "Grace");
    await page.click('#register button[type="submit"]');
    await page.waitForSelector("#in:not([hidden])", { timeout: 8000 }).catch(() => {});
    const made = { who: await page.locator("#who").textContent(), status: await status() };
    await page.click("#signout");
    await page.waitForSelector("#out:not([hidden])", { timeout: 8000 }).catch(() => {});
    await page.click("#signin");
    await page.waitForSelector("#in:not([hidden])", { timeout: 8000 }).catch(() => {});
    const back = { who: await page.locator("#who").textContent(), status: await status() };
    check("a person makes an account with a passkey on /account/, signs out, and signs back in with it", made.who === "Grace" && back.who === "Grace" && /signed in/.test(back.status ?? ""), JSON.stringify({ made, back }));
  } finally {
    await own.close();
    await server.stop();
    await rm(spaces, { recursive: true, force: true });
  }
}
