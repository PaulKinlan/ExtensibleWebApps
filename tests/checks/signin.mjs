// Signing in with a passkey in a real browser, and sharing a space: the account page (/account/) on
// the Node host, with Chromium's virtual authenticator standing in for a
// phone or a laptop's fingerprint reader. tests/server/run.mjs checks the
// server's side in more detail, on both hosts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

/** Chromium's virtual authenticator for a page: a passkey store that says yes without a prompt. */
async function withAuthenticator(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

export default async function ({ check, context, errors }) {
  const spaces = await mkdtemp(join(tmpdir(), "signin-"));
  // Passkeys need a secure context: localhost counts, an IP address doesn't.
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" });
  const own = await context.browser().newContext();
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  let other;
  try {
    await withAuthenticator(own, page);
    const status = () => page.locator(".account-view .status").textContent();
    await page.goto(`${server.url}/account/`);
    await page.fill('form[data-action="register"] input[name="name"]', "Grace");
    await page.click('form[data-action="register"] button[type="submit"]');
    await page.waitForSelector(".signed-in", { timeout: 8000 }).catch(() => {});
    const made = { who: await page.locator(".who").textContent(), status: await status() };
    await page.click('[data-action="signout"]');
    await page.waitForSelector(".signed-out", { timeout: 8000 }).catch(() => {});
    await page.click('[data-action="signin"]');
    await page.waitForSelector(".signed-in", { timeout: 8000 }).catch(() => {});
    const back = { who: await page.locator(".who").textContent(), status: await status() };
    check("a person makes an account with a passkey on /account/, signs out, and signs back in with it", made.who === "Grace" && back.who === "Grace" && /signed in/.test(back.status ?? ""), JSON.stringify({ made, back }));

    await page.fill('form[data-action="make"] input[name="name"]', "grace-home");
    await page.click('form[data-action="make"] button[type="submit"]');
    await page.waitForSelector(".space-list strong", { timeout: 8000 }).catch(() => {});
    await page.click('.space-list button:has-text("Invite someone")');
    await page.waitForSelector(".invite input", { timeout: 8000 }).catch(() => {});
    const link = await page.inputValue(".invite input").catch(() => "");

    // Someone else, on their own device, opens the invite and makes an account.
    other = await context.browser().newContext();
    const theirs = await other.newPage();
    theirs.on("pageerror", (e) => errors.push(e.message));
    await withAuthenticator(other, theirs);
    await theirs.goto(link || `${server.url}/account/`);
    await theirs.fill('form[data-action="register"] input[name="name"]', "Hopper");
    await theirs.click('form[data-action="register"] button[type="submit"]');
    await theirs.waitForSelector(".space-list strong", { timeout: 8000 }).catch(() => {});
    const joined = { status: await theirs.locator(".account-view .status").textContent(), spaces: await theirs.locator(".space-list").textContent() };
    check("a space made on /account/ gets an invite link, and whoever opens it and signs up is in the space", /invite=/.test(link) && /joined grace-home/.test(joined.status ?? "") && /grace-home \(member\)/.test(joined.spaces ?? ""), JSON.stringify({ link, joined }));
  } finally {
    await other?.close();
    await own.close();
    await server.stop();
    await rm(spaces, { recursive: true, force: true });
  }
}
