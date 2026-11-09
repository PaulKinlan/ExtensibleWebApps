// Space plugins, in a real browser (std/spaces/plugins.ts): a plugin a
// member adds to an app in a space is theirs alone until they share it with
// the space (from Customize); then it reaches the other member's device,
// turned off there; turning it on is each person's own choice; a change to it
// arrives off again; removing it removes it for everyone; and stopping
// sharing it takes it from the others and leaves it with its owner.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

const APP = "demos/reading-list";
const FORM = '[data-key="library:books"] ui-form';
const plugin = (text) => `export const manifest = { id: "shelf-note", name: "Shelf note", description: "${text}", permissions: [] };\nexport default () => {};`;

async function signUp(browser, address, name, errors) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`space-plugins ${name}: ${e.message}`));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto(address);
  await page.fill("#name", name);
  await page.click('#register button[type="submit"]');
  await page.waitForSelector("#in:not([hidden])", { timeout: 8000 });
  return { context, page };
}

const command = (page, name, arg) => page.evaluate(([n, a]) => window.__host.command(n, a), [name, arg]);
const list = (page) => command(page, "user:list", { app: APP }).then((l) => (Array.isArray(l) ? l : []), () => []);
/** Waits until the device's own plugins for the app pass `test`, and gives the last list it saw. */
async function until(page, test, ms = 15000) {
  let seen = [];
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
    seen = await list(page);
    if (test(seen)) return { ok: true, seen };
  }
  return { ok: false, seen };
}
const note = (l) => l.find((p) => p.id === "shelf-note");

export default async function ({ check, context, errors }) {
  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "space-plugins-"));
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" });
  const devices = [];
  try {
    const ann = await signUp(browser, `${server.url}/account/`, "Ann", errors);
    devices.push(ann.context);
    await ann.page.fill("#space-name", "home");
    await ann.page.click('#new-space button[type="submit"]');
    await ann.page.waitForSelector('#spaces button:has-text("Invite someone")', { timeout: 8000 });
    await ann.page.click('#spaces button:has-text("Invite someone")');
    await ann.page.waitForSelector("#invite-link:not([hidden])", { timeout: 8000 });
    const ben = await signUp(browser, await ann.page.inputValue("#invite-url"), "Ben", errors);
    devices.push(ben.context);
    for (const { page } of [ann, ben]) {
      await page.goto(`${server.url}/s/home/${APP}/`);
      await page.waitForSelector(FORM, { timeout: 15000 });
    }

    // Ann adds a plugin to the app in the space, and turns it on for herself: it's hers alone.
    const added = await command(ann.page, "user:add", { app: APP, files: [{ name: "shelf-note.js", data: plugin("first") }] });
    await command(ann.page, "user:on", { app: APP, id: "shelf-note" });
    const leaked = await until(ben.page, (l) => !!note(l), 2500);
    check("space plugins: a plugin a member adds in a space is their own until they share it", added?.ok && !leaked.ok && note(await list(ann.page))?.shared === false, JSON.stringify({ added, ben: leaked.seen }));

    // She shares it from Customize.
    await ann.page.click("ui-panel .launch");
    const share = ann.page.locator('button[data-share="shelf-note"]');
    await share.waitFor({ timeout: 8000 });
    await share.click();
    // Customize is a plugin, so sharing waits for her to accept a review card.
    await ann.page.click('[data-key^="review:"] >> text=Accept', { timeout: 8000 }).catch(() => {});
    await ann.page.locator('button[data-share="shelf-note"]', { hasText: "Stop sharing" }).waitFor({ timeout: 8000 }).catch(() => {});
    const arrived = await until(ben.page, (l) => !!note(l));
    check(
      "space plugins: one she shares from Customize reaches another member's device, turned off there, as the space's",
      arrived.ok && note(arrived.seen)?.on === false && note(arrived.seen)?.shared === true && note(arrived.seen)?.description === "first",
      JSON.stringify(arrived.seen),
    );
    const annHas = note(await list(ann.page));
    check("space plugins: turning a shared plugin on is each person's own choice", annHas?.on === true && note(await list(ben.page))?.on === false, JSON.stringify(annHas));

    // Ben turns it on; Ann changes it: it reaches Ben changed, and off again.
    await command(ben.page, "user:on", { app: APP, id: "shelf-note" });
    await command(ann.page, "user:add", { app: APP, files: [{ name: "shelf-note.js", data: plugin("second") }] });
    const changed = await until(ben.page, (l) => note(l)?.description === "second");
    check("space plugins: a change to a shared plugin reaches every member's device, turned off again", changed.ok && note(changed.seen)?.on === false, JSON.stringify(changed.seen));

    // Ben removes it: it goes from Ann's device too.
    await command(ben.page, "user:remove", { app: APP, id: "shelf-note" });
    const gone = await until(ann.page, (l) => !note(l));
    check("space plugins: removing a shared plugin removes it from every member's device", gone.ok, JSON.stringify(gone.seen));

    // Ann adds it again and shares it, then stops sharing: it goes from Ben, and stays hers.
    await command(ann.page, "user:add", { app: APP, files: [{ name: "shelf-note.js", data: plugin("third") }] });
    await command(ann.page, "user:share", { app: APP, id: "shelf-note" });
    const again = await until(ben.page, (l) => note(l)?.description === "third");
    await command(ann.page, "user:unshare", { app: APP, id: "shelf-note" });
    const taken = await until(ben.page, (l) => !note(l));
    const annKeeps = note(await list(ann.page));
    check("space plugins: stopping sharing takes it from the other members and leaves it with its owner, as her own", again.ok && taken.ok && annKeeps?.shared === false, JSON.stringify({ again: again.ok, ben: taken.seen, annKeeps }));
  } finally {
    for (const device of devices) await device.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true });
  }
}
