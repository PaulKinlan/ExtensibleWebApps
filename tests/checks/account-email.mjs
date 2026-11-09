// The account page's email field (account/index.html): someone signed in gives
// the address their spaces' apps may email them at, gets a link to confirm it,
// opens it, sends themselves a test message, and can take the address away. The
// email service mails only confirmed addresses (tests/server/run.mjs checks that).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";
import { smtpMailer } from "../../src/server/smtp.ts";
import { fakeSmtp } from "../server/fake-smtp.mjs";

export default async function ({ check, context, errors }) {
  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "account-email-"));
  const mailbox = await fakeSmtp();
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js", email: smtpMailer({ url: `smtp://127.0.0.1:${mailbox.port}`, from: "Spaces <spaces@example.com>" }) });
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
    const status = (text) => page.locator("#status").filter({ hasText: text }).waitFor({ timeout: 8000 }).then(() => true, () => false);

    await page.fill("#email-address", "robin@example.com");
    await page.click('#email button[type="submit"]');
    const asked = await status("link to confirm");
    const waiting = await page.textContent("#email-state");
    const testHidden = await page.isHidden("#email-test");
    const link = /https?:\/\/\S+\/account\/\?confirm=\S+/.exec(mailbox.received.at(-1)?.text ?? "")?.[0];

    await page.goto(link ?? `${server.url}/account/`);
    const confirmed = await status("confirmed");
    await page.waitForFunction(() => document.querySelector("#email-state")?.textContent?.startsWith("Confirmed"), null, { timeout: 5000 }).catch(() => {});
    const state = await page.textContent("#email-state");
    await page.click("#email-test");
    const tested = await status("on its way");
    const arrived = mailbox.received.some((m) => m.subject.startsWith("A test message") && m.to.includes("robin@example.com"));
    check(
      "account email: saving an address mails it a link; opening the link confirms it, and then a test message can be sent to it",
      asked && /Not confirmed/.test(waiting ?? "") && testHidden && !!link && confirmed && /^Confirmed/.test(state ?? "") && tested && arrived,
      JSON.stringify({ asked, waiting, testHidden, link: !!link, confirmed, state, tested, arrived }),
    );

    await page.fill("#email-address", "");
    await page.click('#email button[type="submit"]');
    await status("removed");
    const me = await page.evaluate(() => fetch("/auth/me").then((r) => r.json()));
    check("account email: an empty address takes it away", me.user && !("email" in me.user) && !("emailConfirmed" in me.user), JSON.stringify(me));
  } finally {
    await phone.close().catch(() => {});
    await server.stop().catch(() => {});
    mailbox.close();
    await rm(spaces, { recursive: true, force: true });
  }
}
