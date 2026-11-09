// The account page's email field (account/email.js): someone signed in gives
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
    await page.fill('form[data-action="register"] input[name="name"]', "Robin");
    await page.click('form[data-action="register"] button[type="submit"]');
    await page.waitForSelector(".signed-in", { timeout: 8000 });
    const status = (text) => page.locator('[role="status"]').filter({ hasText: text }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);

    await page.fill('form[data-action="save"] input[name="email"]', "robin@example.com");
    await page.click('form[data-action="save"] button[type="submit"]');
    const asked = await status("link to confirm");
    await page.waitForFunction(() => document.querySelector(".email .state")?.textContent?.startsWith("Not confirmed"), null, { timeout: 5000 }).catch(() => {});
    const waiting = await page.textContent(".email .state");
    const testHidden = await page.isHidden('[data-action="test"]');
    const link = /https?:\/\/\S+\/account\/\?confirm=\S+/.exec(mailbox.received.at(-1)?.text ?? "")?.[0];

    await page.goto(link ?? `${server.url}/account/`);
    const confirmed = await status("confirmed");
    await page.waitForFunction(() => document.querySelector(".email .state")?.textContent?.startsWith("Confirmed"), null, { timeout: 5000 }).catch(() => {});
    const state = await page.textContent(".email .state");
    await page.click('[data-action="test"]');
    const tested = await status("on its way");
    const arrived = mailbox.received.some((m) => m.subject.startsWith("A test message") && m.to.includes("robin@example.com"));
    check(
      "account email: saving an address mails it a link; opening the link confirms it, and then a test message can be sent to it",
      asked && /Not confirmed/.test(waiting ?? "") && testHidden && !!link && confirmed && /^Confirmed/.test(state ?? "") && tested && arrived,
      JSON.stringify({ asked, waiting, testHidden, link: !!link, confirmed, state, tested, arrived }),
    );

    // Only the last link counts: one mailed before the address was removed and saved again confirms nothing.
    const post = (path, body) => page.evaluate(([p, b]) => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.status), [path, body]);
    const tokenTo = (to) => /confirm=([A-Za-z0-9_-]+)/.exec(mailbox.received.filter((m) => m.to.includes(to)).at(-1)?.text ?? "")?.[1];
    await post("/auth/me/email", { email: "robin2@example.com" });
    const first = tokenTo("robin2@example.com");
    await post("/auth/me/email", { email: "" });
    await post("/auth/me/email", { email: "robin2@example.com" });
    const second = tokenTo("robin2@example.com");
    const stale = await post("/auth/me/email/confirm", { token: first });
    const fresh = await post("/auth/me/email/confirm", { token: second });
    check("account email: a link mailed before the address was removed and saved again confirms nothing; the newest does", first !== second && stale === 400 && fresh === 200, JSON.stringify({ stale, fresh }));

    await page.fill('form[data-action="save"] input[name="email"]', "");
    await page.click('form[data-action="save"] button[type="submit"]');
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
