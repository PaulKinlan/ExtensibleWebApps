// Sharing a survey, in a real browser: someone signs in, makes a space, opens
// Surveys from their account page, and presses Share link on a survey. The
// share sheet gets the survey's whole public address in the space, and that
// address is the form, for anyone, signed in or not. (tests/server/run.mjs
// checks the form and its answers; this is the way there.)
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

const VIEW = '[data-plugin="surveys"]';

export default async function ({ check, context, errors }) {
  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "survey-share-"));
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await phone.newPage();
    page.on("pageerror", (e) => errors.push(`survey-share: ${e.message}`));
    const cdp = await phone.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    await page.goto(`${server.url}/account/`);
    await page.fill("#name", "Sam");
    await page.click('#register button[type="submit"]');
    await page.waitForSelector("#in:not([hidden])", { timeout: 8000 });
    await page.fill("#space-name", "polls");
    await page.click('#new-space button[type="submit"]');

    // The account page links Surveys in each space.
    const open = page.locator('#spaces a:has-text("Open surveys in it")');
    await open.waitFor({ timeout: 8000 });
    const href = await open.getAttribute("href");
    check("survey share: the account page opens Surveys in each of your spaces", href === "/s/polls/demos/survey/", String(href));
    await open.click();
    const button = `${VIEW} .survey[key="sample-launch"] button[data-action="share"]`;
    const shown = await page.waitForSelector(button, { timeout: 15000 }).then(() => true, () => false);

    await page.evaluate(() => (navigator.share = async (data) => void (window.__shared = data)));
    if (shown) await page.click(button);
    const sent = await page.waitForFunction(() => window.__shared, null, { timeout: 5000 }).then((h) => h.jsonValue(), () => null);
    const address = `${server.url}/s/polls/demos/survey/answer?survey=sample-launch`;
    check("survey share: Share link hands the survey's whole public address in the space to the share sheet", shown && sent?.url === address && sent?.title === "How was the launch party?", JSON.stringify({ shown, sent }));

    // And that address is the form, for someone who isn't signed in.
    // The sample reaches the space's server through sync, a moment after the tab shows it.
    let form = "";
    for (const until = Date.now() + 8000; Date.now() < until && !/<form method="post"/.test(form); await new Promise((r) => setTimeout(r, 200))) form = await fetch(address).then((r) => r.text());
    check("survey share: the shared address is the survey's form, for anyone", /<form method="post"/.test(form) && form.includes("How was the launch party?"));
  } finally {
    await phone.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true });
  }
}
