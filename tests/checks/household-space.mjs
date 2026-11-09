// The household demo (demos/household/) shared by two people, in a real
// browser: Ann makes a space and invites Ben, and each opens the app at
// /s/<space>/demos/household/ on a device of their own. Each is shown by
// the name on their account (nobody types one), and what one adds, gets or
// does shows on the other's phone with their name. Then the server goes away: both keep working, both get the bread,
// and when it's back the phones agree, with the version the space didn't
// take kept as a draft that std/sync.js shows. The platform's own sync checks
// are tests/checks/space-sync.mjs; this one is about an app made to share.
import { watchErrors } from "../page-errors.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

const WHO = '[data-key="housemates:who"]';
const LIST = '[data-key="groceries:list"]';
const CHORES = '[data-key="chores:list"]';
const SYNC = '[data-key^="sync-status"]';

async function withAuthenticator(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

/** Signs up on /account/ (from `address`, which may be an invite link), on a phone of their own. */
async function signUp(browser, address, name, errors) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  watchErrors(page, errors, `household-space ${name}`);
  await withAuthenticator(context, page);
  await page.goto(address);
  await page.fill('form[data-action="register"] input[name="name"]', name);
  await page.click('form[data-action="register"] button[type="submit"]');
  await page.waitForSelector(".signed-in", { timeout: 8000 });
  return { context, page };
}

/** Opens the household app in the space, and waits for the shopping list. */
async function open(page, base) {
  await page.goto(`${base}/s/flat/demos/household/`);
  // A first visit loads through 404.html, which starts the service worker and loads the address again.
  await page.waitForSelector(`${LIST} form`, { timeout: 15000 });
}

const row = (page, view, text) => page.locator(`${view} li`, { hasText: text }).first();
const shows = (page, view, text, timeout = 20000) => row(page, view, text).waitFor({ timeout }).then(() => true, () => false);
const rows = (page, view) => page.locator(`${view} li`).allTextContents().then((t) => t.map((s) => s.replace(/\s+/g, " ").trim()), () => []);
const add = async (page, item) => {
  await page.fill(`${LIST} form input[name="item"]`, item);
  await page.click(`${LIST} form button[type="submit"]`);
  await row(page, LIST, item).waitFor({ timeout: 5000 }).catch(() => {});
};
const get = (page, item) => row(page, LIST, item).locator('input[type="checkbox"]').click();
const state = (page) => page.evaluate(() => window.__host.command("sync"));
const settled = (page) =>
  page.waitForFunction(async () => { const s = await window.__host.command("sync"); return s.connected && s.pending === 0; }, null, { timeout: 40000, polling: 500 }).then(() => true, () => false);

export default async function ({ check, context, errors }) {
  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "household-"));
  const options = { port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" };
  let server = await serve(options);
  const port = Number(new URL(server.url).port);
  const phones = [];
  try {
    // Ann makes the space and invites Ben.
    const ann = await signUp(browser, `${server.url}/account/`, "Ann", errors);
    phones.push(ann.context);
    await ann.page.fill('form[data-action="make"] input[name="name"]', "flat");
    await ann.page.click('form[data-action="make"] button[type="submit"]');
    await ann.page.waitForSelector('.space-list button:has-text("Invite someone")', { timeout: 8000 });
    await ann.page.click('.space-list button:has-text("Invite someone")');
    await ann.page.waitForSelector(".invite input", { timeout: 8000 });
    const link = await ann.page.inputValue(".invite input");
    const ben = await signUp(browser, link, "Ben", errors);
    phones.push(ben.context);

    // Each is shown by the name on their account, and sees the other.
    await open(ann.page, server.url);
    await open(ben.page, server.url);
    const annSees = await ann.page.waitForSelector(`${WHO} >> text=You're Ann · also here: Ben`, { timeout: 20000 }).then(() => true, () => false);
    const benSees = await ben.page.waitForSelector(`${WHO} >> text=You're Ben · also here: Ann`, { timeout: 20000 }).then(() => true, () => false);
    check("household: in a space, each phone shows who it's signed in as and who else lives there, by their account names, with no name to type", annSees && benSees && !(await ben.page.locator(`${WHO} input`).count()), JSON.stringify({ ann: await ann.page.locator(WHO).textContent().catch(() => ""), ben: await ben.page.locator(WHO).textContent().catch(() => "") }));

    // The sample items went in once, though both phones started the list.
    const milk = (await rows(ben.page, LIST)).filter((t) => /^Milk\b/.test(t)).length;
    check("household: two phones starting the shared list add its sample items once", milk === 1, JSON.stringify(await rows(ben.page, LIST)));

    // What one adds shows on the other's phone, signed; "you" on their own.
    await add(ann.page, "Oat milk");
    const signed = await shows(ben.page, LIST, "Oat milk · Ann added it");
    const own = await shows(ann.page, LIST, "Oat milk · you added it", 5000);
    check("household: an item one person adds shows on the other's phone, with who added it", signed && own, JSON.stringify(await rows(ben.page, LIST)));

    await get(ben.page, "Oat milk");
    const got = await shows(ann.page, LIST, "Oat milk · Ben got it");
    check("household: ticking an item off shows on the other phone, with who got it", got, JSON.stringify(await rows(ann.page, LIST)));

    // The server goes away. Ann adds eggs, Ben puts the bins out, and both get the bread.
    await server.stop();
    await add(ann.page, "Eggs");
    await row(ben.page, CHORES, "Put the bins out").locator('button:has-text("Done")').click();
    await get(ann.page, "Bread");
    await get(ben.page, "Bread");
    const offline = (await shows(ann.page, LIST, "Eggs", 5000)) && (await shows(ben.page, CHORES, "You did it today", 5000));
    const waiting = await state(ann.page);
    check("household: with the server gone, each phone keeps working and keeps what changed to send later", offline && waiting?.pending >= 1 && !waiting.connected, JSON.stringify(waiting));

    // It's back: each hears what the other did, with their name.
    server = await serve({ ...options, port });
    const heard = (await shows(ben.page, LIST, "Eggs · Ann added it", 40000)) && (await shows(ann.page, CHORES, "Ben did it today", 40000));
    check("household: when the server is back, what each did offline reaches the other, with who did it", heard, JSON.stringify({ ann: await rows(ann.page, CHORES), ben: await rows(ben.page, LIST) }));

    // Both got the bread: the phones agree on who, and the other version is a draft, shown on that phone.
    await settled(ann.page);
    await settled(ben.page);
    await ann.page.waitForTimeout(1000);
    const bread = { ann: (await rows(ann.page, LIST)).find((t) => /^Bread/.test(t)), ben: (await rows(ben.page, LIST)).find((t) => /^Bread/.test(t)) };
    const drafts = { ann: (await state(ann.page)).drafts, ben: (await state(ben.page)).drafts };
    // The phone whose change the space took says "you got it"; the other names who did.
    const lost = drafts.ann.length ? "ann" : "ben";
    const won = lost === "ann" ? "ben" : "ann";
    const loser = lost === "ann" ? ann.page : ben.page;
    const agree = bread[won] === "Bread · you got it" && bread[lost] === `Bread · ${won === "ann" ? "Ann" : "Ben"} got it`;
    check(
      "household: two people who got the same item while apart end up agreeing who got it, and one draft is kept",
      agree && drafts.ann.length + drafts.ben.length === 1,
      JSON.stringify({ bread, drafts }),
    );
    const shown = await loser.locator(`${SYNC} .draft`, { hasText: "Bread" }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
    await loser.locator(`${SYNC} .draft button`, { hasText: "Keep theirs" }).first().click().catch(() => {});
    const gone = await loser.locator(`${SYNC} .draft`).waitFor({ state: "detached", timeout: 8000 }).then(() => true, () => false);
    check("household: the phone whose change wasn't kept shows it as a draft, and Keep theirs lets it go", shown && gone && (await state(loser)).drafts.length === 0);
  } finally {
    for (const phone of phones) await phone.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true });
  }
}
