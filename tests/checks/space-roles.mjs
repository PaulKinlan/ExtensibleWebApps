// Who may change what in a space, in a real browser, with the household demo
// (demos/household/): Ann makes a space and invites Ben as a reader. Ben sees
// the lists and is told he can't change them, before he tries and when he
// does; nothing he does reaches Ann. Ann makes him an editor on her account
// page, and then he can add, but removes only the chore he added (the
// collection's rule), while Ann, the owner, removes any. The same at the
// route level, on both hosts: tests/server/roles.mjs.
import { watchErrors } from "../page-errors.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

const LIST = '[data-key="groceries:list"]';
const CHORES = '[data-key="chores:list"]';
const SYNC = '[data-key^="sync-status"]';

async function signUp(browser, address, name, errors) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  watchErrors(page, errors, `space-roles ${name}`);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto(address);
  await page.fill('form[data-action="register"] input[name="name"]', name);
  await page.click('form[data-action="register"] button[type="submit"]');
  await page.waitForSelector(".signed-in", { timeout: 8000 });
  return { context, page };
}

const open = async (page, base) => {
  await page.goto(`${base}/s/den/demos/household/`);
  await page.waitForSelector(`${LIST} form`, { timeout: 15000 });
};
const row = (page, view, text) => page.locator(`${view} li`, { hasText: text }).first();
const shows = (page, view, text, timeout = 15000) => row(page, view, text).waitFor({ timeout }).then(() => true, () => false);
const text = (page, selector) => page.locator(selector).first().textContent({ timeout: 8000 }).then((t) => (t ?? "").replace(/\s+/g, " ").trim(), () => "");
const role = (page) => page.evaluate(() => window.__host.command("sync")).then((s) => s?.access?.role, () => undefined);
const until = async (ask, want, ms = 15000) => {
  let seen;
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) if (want((seen = await ask()))) return seen;
  return seen;
};

export default async function ({ check, context, errors }) {
  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "space-roles-"));
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" });
  const devices = [];
  try {
    const ann = await signUp(browser, `${server.url}/account/`, "Ann", errors);
    devices.push(ann.context);
    await ann.page.fill('form[data-action="make"] input[name="name"]', "den");
    await ann.page.click('form[data-action="make"] button[type="submit"]');
    await ann.page.waitForSelector('.space-list button:has-text("Invite a reader")', { timeout: 8000 });
    await ann.page.click('.space-list button:has-text("Invite a reader")');
    await ann.page.waitForSelector(".invite input", { timeout: 8000 });
    const said = await text(ann.page, ".invite");
    const ben = await signUp(browser, await ann.page.inputValue(".invite input"), "Ben", errors);
    devices.push(ben.context);
    await ben.page.waitForSelector(".space-list .can", { timeout: 8000 }).catch(() => {});
    const benSees = await text(ben.page, ".space-list");
    check(
      "roles: an owner invites a reader from their account page, and the reader's own page says what they can do",
      /see what the space keeps, but not change it/.test(said) && /den \(reader\)/.test(benSees) && /but not change it\. Its owner can make you an editor/.test(benSees),
      JSON.stringify({ said, benSees }),
    );

    // Ann opens the household first, so the samples are hers; she adds a chore.
    await open(ann.page, server.url);
    await ann.page.fill(`${CHORES} form input[name="name"]`, "Sweep the yard");
    await ann.page.click(`${CHORES} form button[type="submit"]`);
    await shows(ann.page, CHORES, "Sweep the yard");

    await open(ben.page, server.url);
    await until(() => role(ben.page), (r) => r === "reader");
    const benHas = await shows(ben.page, CHORES, "Sweep the yard");
    await ben.page.waitForSelector(`${SYNC} [data-part="role"]`, { timeout: 8000 }).catch(() => {});
    const told = await text(ben.page, `${SYNC} [data-part="role"]`);
    await ben.page.waitForSelector(`${CHORES} .why`, { timeout: 8000 }).catch(() => {});
    const chores = { form: await ben.page.locator(`${CHORES} form`).count(), buttons: await ben.page.locator(`${CHORES} li button`).count(), why: await text(ben.page, `${CHORES} .why`) };
    check(
      "roles: a reader sees what the space keeps, and is told before trying that they can't change it and whom to ask",
      benHas && /can see what den keeps, but not change it\. Its owner, Ann, can make you an editor/.test(told) && chores.form === 0 && chores.buttons === 0 && /Ask the space's owner, Ann, to make you an editor/.test(chores.why),
      JSON.stringify({ benHas, told, chores }),
    );
    if (process.env.SHOTS) await ben.page.screenshot({ path: `${process.env.SHOTS}/reader-household-phone.png` }).catch(() => {});

    // A view that offers the form anyway (the shopping list): the write is stopped on his phone, and he is told why.
    await ben.page.fill(`${LIST} form input[name="item"]`, "Caviar");
    await ben.page.click(`${LIST} form button[type="submit"]`);
    const notice = await ben.page.waitForSelector("#notice p", { timeout: 8000 }).then((p) => p.textContent(), () => "");
    await new Promise((r) => setTimeout(r, 1500));
    const leaked = { ben: await ben.page.locator(`${LIST} li`, { hasText: "Caviar" }).count(), ann: await ann.page.locator(`${LIST} li`, { hasText: "Caviar" }).count(), drafts: (await ben.page.evaluate(() => window.__host.command("sync")))?.drafts?.length };
    check(
      "roles: a reader who tries anyway is told on the page who can make the change, and it never shows on their phone or anyone else's",
      /You can read this space but not change it\. Ask the space's owner, Ann, to make you an editor\./.test(notice ?? "") && leaked.ben === 0 && leaked.ann === 0 && leaked.drafts === 0,
      JSON.stringify({ notice, leaked }),
    );

    // Customize says it too, where a reader would look to add things.
    await ben.page.click("ui-panel .launch").catch(() => {});
    const inCustomize = await ben.page.waitForSelector('[data-part="role"]:has-text("reader in this space")', { timeout: 8000 }).then((p) => p.textContent(), () => "");
    await ben.page.keyboard.press("Escape");
    check("roles: Customize tells a reader what they can and can't do in the space", /You're a reader in this space.*Its owner, Ann, can make you an editor/.test(inCustomize ?? ""), String(inCustomize));

    // Ann makes him an editor, on her account page.
    const account = await ann.context.newPage();
    watchErrors(account, errors, "space-roles Ann's account");
    await account.goto(`${server.url}/account/`);
    await account.waitForSelector('.members li:has-text("Ben")', { timeout: 8000 });
    const before = await text(account, '.members li:has-text("Ben")');
    await account.click('.members li:has-text("Ben") button:has-text("Make an editor")');
    await account.waitForSelector('.members li:has-text("Ben") button:has-text("Make a reader")', { timeout: 8000 }).catch(() => {});
    const after = await text(account, '.members li:has-text("Ben")');
    const status = await text(account, ".spaces .status");
    check("roles: the owner's account page lists who is in a space and as what, and changes a reader to an editor", /Ben\s*Reader/.test(before) && /Ben\s*Editor/.test(after) && /can now change what den keeps/.test(status), JSON.stringify({ before, after, status }));
    if (process.env.SHOTS) {
      await account.screenshot({ path: `${process.env.SHOTS}/account-members-phone.png`, fullPage: true }).catch(() => {});
      await account.setViewportSize({ width: 1100, height: 900 });
      await account.screenshot({ path: `${process.env.SHOTS}/account-members-desktop.png`, fullPage: true }).catch(() => {});
    }
    await account.close();

    // His phone hears of it without a reload: its connection is closed and opens again with the new role.
    const now = await until(() => role(ben.page), (r) => r === "editor", 20000);
    await ben.page.waitForSelector(`${CHORES} form`, { timeout: 10000 }).catch(() => {});
    await ben.page.fill(`${CHORES} form input[name="name"]`, "Feed the cat").catch(() => {});
    await ben.page.click(`${CHORES} form button[type="submit"]`).catch(() => {});
    const reached = await shows(ann.page, CHORES, "Feed the cat");
    check("roles: made an editor, the same phone can change the space without being reloaded", now === "editor" && reached, JSON.stringify({ now, reached }));

    // The chores' rule: only whoever added a chore, or the owner, removes it.
    await ben.page.waitForSelector(`${CHORES} li:has-text("Feed the cat") button[data-action^="remove:"]`, { timeout: 10000 }).catch(() => {});
    const benCan = { own: await row(ben.page, CHORES, "Feed the cat").locator('button[data-action^="remove:"]').count(), anns: await row(ben.page, CHORES, "Sweep the yard").locator('button[data-action^="remove:"]').count(), done: await row(ben.page, CHORES, "Sweep the yard").locator('button[data-action^="done:"]').count() };
    const annCan = { bens: await row(ann.page, CHORES, "Feed the cat").locator('button[data-action^="remove:"]').count(), own: await row(ann.page, CHORES, "Sweep the yard").locator('button[data-action^="remove:"]').count() };
    await row(ben.page, CHORES, "Feed the cat").locator('button[data-action^="remove:"]').click().catch(() => {});
    const gone = await row(ann.page, CHORES, "Feed the cat").waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);
    check(
      "rules: an editor is offered Remove only on the chore they added and Done on any; the owner on all; and removing their own reaches everyone",
      benCan.own === 1 && benCan.anns === 0 && benCan.done === 1 && annCan.bens === 1 && annCan.own === 1 && gone,
      JSON.stringify({ benCan, annCan, gone }),
    );
  } finally {
    for (const device of devices) await device.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true });
  }
}
