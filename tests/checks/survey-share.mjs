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
    // Surveys links the account page as /account/?app=/demos/survey/, so it offers that app in each space.
    await page.goto(`${server.url}/account/?app=/demos/survey/`);
    await page.fill("#name", "Sam");
    await page.click('#register button[type="submit"]');
    await page.waitForSelector("#in:not([hidden])", { timeout: 8000 });
    await page.fill("#space-name", "polls");
    await page.click('#new-space button[type="submit"]');

    // The account page links Surveys in each space, and the site's front page, and names no other app.
    const open = page.locator('#spaces a:has-text("Open Surveys in it")');
    await open.waitFor({ timeout: 8000 });
    const href = await open.getAttribute("href");
    check("survey share: the account page opens Surveys in each of your spaces", href === "/s/polls/demos/survey/", String(href));
    const links = await page.locator("#spaces a:not([download])").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    check("account: a space opens only the app you came from and the site, never a hardcoded demo", JSON.stringify(links) === JSON.stringify(["/s/polls/demos/survey/", "/s/polls/"]), JSON.stringify(links));
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

    // In a browser, the link is followed past the service worker, which answers other addresses in a space with
    // the app's page: the survey's author, opening their own link, and a friend who isn't signed in but has been
    // to the site before (so the service worker is theirs too) both get the form, not the app.
    const formIn = async (tab) => {
      await tab.goto(address);
      return tab.locator('form[method="post"] button[type="submit"]').waitFor({ timeout: 8000 }).then(() => true, () => false);
    };
    const author = await formIn(page);
    const friend = await browser.newContext();
    try {
      const tab = await friend.newPage();
      tab.on("pageerror", (e) => errors.push(`survey-share friend: ${e.message}`));
      await tab.goto(`${server.url}/demos/survey/`);
      // The first visit may load the page again once the service worker starts: wait for the app, then for the worker.
      await tab.waitForSelector(VIEW, { timeout: 15000 }).catch(() => {});
      const controlled = await tab.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 8000 }).then(() => true, () => false);
      const seen = await formIn(tab);
      if (seen) {
        await tab.locator('input[type="radio"]').first().check();
        await tab.click('form[method="post"] button[type="submit"]');
      }
      const thanked = await tab.getByText("are in").waitFor({ timeout: 8000 }).then(() => true, () => false);
      check("survey share: opened in a browser with the site's service worker, the link is the survey's form, for its author and for a friend who isn't signed in, and the friend's answer is taken", controlled && author && seen && thanked, JSON.stringify({ author, controlled, seen, thanked }));
    } finally {
      await friend.close().catch(() => {});
    }
  } finally {
    await phone.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true });
  }
}
