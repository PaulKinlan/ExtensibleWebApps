// Two people's devices sharing a space, in a real browser: each opens the
// reading list at /s/<space>/demos/reading-list/, keeps a copy of the space's
// data in its own kernel, and syncs with the Node host's space kernel
// (src/kernel/sync-device.ts, src/kernel/sync.ts). Then the server goes away
// for a while: both keep working, and when it's back, what each did reaches
// the other, and a record both changed ends up the same, with the loser's
// version kept as a draft. tests/server/run.mjs checks the space's side alone.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

const FORM = '[data-key="library:books"] ui-form';
const TABLE = '[data-key="library:books"] ui-table';

async function withAuthenticator(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

/** Signs up on /account/ (from `address`, which may be an invite link), on a device of its own. */
async function signUp(browser, address, name, errors) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await withAuthenticator(context, page);
  await page.goto(address);
  await page.fill("#name", name);
  await page.click('#register button[type="submit"]');
  await page.waitForSelector("#in:not([hidden])", { timeout: 8000 });
  return { context, page };
}

/** Opens the reading list in the space, and waits for its form. */
async function openList(page, base) {
  await page.goto(`${base}/s/home/demos/reading-list/`);
  // A first visit loads through 404.html, which starts the service worker and loads the address again.
  await page.waitForSelector(FORM, { timeout: 15000 });
}

const titles = (page) => page.locator(`${TABLE} tbody tr`).allTextContents().catch(() => []);
const hasTitle = (page, title, timeout = 15000) => page.locator(`${TABLE} tbody tr`, { hasText: title }).first().waitFor({ timeout }).then(() => true, () => false);
const addBook = async (page, title) => {
  await page.fill(`${FORM} input[name="title"]`, title);
  await page.click(`${FORM} button[type="submit"]`);
};
/** Opens a book from the table and saves it with a new title. */
const rename = async (page, from, to) => {
  await page.locator(`${TABLE} tbody tr`, { hasText: from }).first().locator("button").first().click();
  await page.waitForSelector(`${FORM} button:has-text("Save changes")`, { timeout: 8000 });
  await page.fill(`${FORM} input[name="title"]`, to);
  await page.click(`${FORM} button:has-text("Save changes")`);
  await hasTitle(page, to, 5000);
};
const sync = (page) => page.evaluate(() => window.__host.command("sync"));

export default async function ({ check, context, errors }) {
  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "space-sync-"));
  const options = { port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" };
  let server = await serve(options);
  const port = Number(new URL(server.url).port);
  const devices = [];
  try {
    // Ann makes the space and invites Ben; each has a device of their own.
    const ann = await signUp(browser, `${server.url}/account/`, "Ann", errors);
    devices.push(ann.context);
    await ann.page.fill("#space-name", "home");
    await ann.page.click('#new-space button[type="submit"]');
    await ann.page.waitForSelector('#spaces button:has-text("Invite someone")', { timeout: 8000 });
    await ann.page.click('#spaces button:has-text("Invite someone")');
    await ann.page.waitForSelector("#invite-link:not([hidden])", { timeout: 8000 });
    const link = await ann.page.inputValue("#invite-url");
    const ben = await signUp(browser, link, "Ben", errors);
    devices.push(ben.context);

    await openList(ann.page, server.url);
    await addBook(ann.page, "Middlemarch");
    await openList(ben.page, server.url);
    const reached = await hasTitle(ben.page, "Middlemarch");
    check("a space: a book one person adds in the reading list at /s/<space>/ shows on another person's device", reached, JSON.stringify(await titles(ben.page)));

    // Both devices added the app's sample books, which have ids of their own: the space has each once.
    const samples = (await titles(ben.page)).filter((t) => t.includes("Piranesi")).length;
    check("a space: two devices adding an app's sample records add them once", samples === 1, JSON.stringify(await titles(ben.page)));

    // Ann's own reading list, outside the space, is hers alone.
    const own = await ann.context.newPage();
    await own.goto(`${server.url}/demos/reading-list/`);
    await own.waitForSelector(FORM, { timeout: 15000 });
    const apart = (await hasTitle(own, "Piranesi")) && !(await hasTitle(own, "Middlemarch", 1500));
    await own.close();
    check("a space: its data is kept apart from the person's own copy of the same app", apart);

    // The server goes away. Both keep working on their own copies.
    await server.stop();
    await addBook(ann.page, "Emma");
    await addBook(ben.page, "Persuasion");
    const offline = (await hasTitle(ann.page, "Emma", 5000)) && (await hasTitle(ben.page, "Persuasion", 5000));
    const waiting = await sync(ann.page);
    check("a space: with the server gone, each device keeps working, and keeps what it changed to send later", offline && waiting?.pending >= 1 && !waiting.connected, JSON.stringify(waiting));

    // It's back: what each did reaches the other.
    server = await serve({ ...options, port });
    const both = (await hasTitle(ann.page, "Persuasion", 40000)) && (await hasTitle(ben.page, "Emma", 40000));
    const after = await sync(ann.page);
    check("a space: when the server is back, each device sends what it did, and hears what the other did", both && after?.pending === 0 && after.connected, JSON.stringify({ ann: await titles(ann.page), ben: await titles(ben.page), after }));

    // Both change the same book while the server is away: when it's back they agree, and the version
    // the space didn't take is kept as a draft on the device that made it.
    await server.stop();
    await rename(ann.page, "Middlemarch", "Middlemarch, by Ann");
    await rename(ben.page, "Middlemarch", "Middlemarch, by Ben");
    server = await serve({ ...options, port });
    const settled = async (page) => page.waitForFunction(async () => { const s = await window.__host.command("sync"); return s.connected && s.pending === 0; }, null, { timeout: 40000, polling: 500 }).then(() => true, () => false);
    await settled(ann.page);
    await settled(ben.page);
    await ann.page.waitForTimeout(1000);
    const final = { ann: (await titles(ann.page)).filter((t) => t.includes("Middlemarch")), ben: (await titles(ben.page)).filter((t) => t.includes("Middlemarch")) };
    const drafts = [...(await sync(ann.page)).drafts, ...(await sync(ben.page)).drafts];
    check(
      "a space: a record two people changed while apart ends up the same on both, and the other version is kept as a draft",
      final.ann.length === 1 && JSON.stringify(final.ann) === JSON.stringify(final.ben) && drafts.length === 1 && /Middlemarch, by (Ann|Ben)/.test(JSON.stringify(drafts[0].mine)) && !final.ann[0].includes(drafts[0].mine?.title),
      JSON.stringify({ final, drafts }),
    );

    // The page that lost shows its draft (std/sync.js); "Use mine" makes it the record again, everywhere.
    const loser = (await sync(ann.page)).drafts.length ? ann.page : ben.page;
    const other = loser === ann.page ? ben.page : ann.page;
    const mine = drafts[0]?.mine?.title ?? "";
    const shown = await loser.locator('[data-key^="sync-status"] .draft', { hasText: "Middlemarch" }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
    const status = (await loser.locator('[data-key^="sync-status"] .status').first().textContent().catch(() => "")) ?? "";
    check("a space: a page shows the draft it kept, and whether it is in step with the space", shown && /In step with home/.test(status), status);
    await loser.locator('[data-key^="sync-status"] .draft button', { hasText: "Use mine" }).first().click().catch(() => {});
    const everywhere = (await hasTitle(loser, mine, 10000)) && (await hasTitle(other, mine, 20000));
    const gone = await loser.locator('[data-key^="sync-status"] .draft').count().catch(() => -1);
    check("a space: Use mine makes a draft the record again, on every device, and the draft goes", everywhere && gone === 0 && (await sync(loser)).drafts.length === 0, JSON.stringify({ mine, loser: await titles(loser), other: await titles(other), gone }));
  } finally {
    for (const device of devices) await device.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true });
  }
}
