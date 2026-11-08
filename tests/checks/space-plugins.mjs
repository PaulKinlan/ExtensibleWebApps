// Members' plugins in a space, in a real browser (src/kernel/shared-plugins.ts):
// a plugin one member adds to an app in the space reaches the other member's
// device, turned off there; turning it on is each person's own choice; a
// change to it arrives off again; and removing it removes it for everyone.
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

    // Ann adds a plugin to the app in the space, and turns it on for herself.
    const added = await command(ann.page, "user:add", { app: APP, files: [{ name: "shelf-note.js", data: plugin("first") }] });
    await command(ann.page, "user:on", { app: APP, id: "shelf-note" });
    const arrived = await until(ben.page, (l) => !!note(l));
    check(
      "members' plugins: a plugin one member adds in a space reaches another member's device, turned off there",
      added?.ok && arrived.ok && note(arrived.seen)?.on === false && note(arrived.seen)?.description === "first",
      JSON.stringify({ added, seen: arrived.seen }),
    );
    const annHas = note(await list(ann.page));
    check("members' plugins: turning a shared plugin on is each person's own choice", annHas?.on === true && note(await list(ben.page))?.on === false, JSON.stringify(annHas));

    // Ben turns it on; Ann changes it: it reaches Ben changed, and off again.
    await command(ben.page, "user:on", { app: APP, id: "shelf-note" });
    await command(ann.page, "user:add", { app: APP, files: [{ name: "shelf-note.js", data: plugin("second") }] });
    const changed = await until(ben.page, (l) => note(l)?.description === "second");
    check("members' plugins: a change to a shared plugin reaches every member's device, turned off again", changed.ok && note(changed.seen)?.on === false, JSON.stringify(changed.seen));

    // Ben removes it: it goes from Ann's device too.
    await command(ben.page, "user:remove", { app: APP, id: "shelf-note" });
    const gone = await until(ann.page, (l) => !note(l));
    check("members' plugins: removing a shared plugin removes it from every member's device", gone.ok, JSON.stringify(gone.seen));
  } finally {
    for (const device of devices) await device.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true });
  }
}
