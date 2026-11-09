// Made apps shared with a space, in a real browser (std/spaces/made-apps.ts,
// std/maker): Ann makes an app at /s/home/new/ and shares it with the space.
// Ben sees it in his Your apps as from the space, shared by Ann, and it runs
// for him only once he accepts its files on a review card. A new version Ann
// shares arrives the same way. When she stops sharing it, Ben keeps his copy.
//
// The folder picker is replaced, as in maker-for-real.mjs: Ann's app comes
// from a folder called "tides" in the browser's private file system.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

const YOURS = '[data-key^="your-apps@"][data-key$=":apps"]';
const REVIEW = '[data-key^="review:"]';
const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tide times</title><link rel="stylesheet" href="/platform/host.css"><script type="module" src="/platform/host.js"></script><link rel="plugin" href="tides.js"></head><body><main><slot name="main"></slot></main></body></html>';
const tides = (text) => `export const manifest = {\n  id: "tide-times",\n  name: "Tides",\n  version: "1.0.0",\n  permissions: ["ui"],\n};\n\nexport default function (ctx) {\n  ctx.ui.render("main", "tides", ctx.ui.html\`<p>${text}</p>\`);\n}\n`;

async function signUp(browser, address, name, errors) {
  const context = await browser.newContext();
  // The folder picker hands out the folder "tides", every time.
  await context.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("tides", { create: true });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`space-made-apps ${name}: ${e.message}`));
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

/** Writes the folder the picker hands out. */
const folder = (page, text, extra = []) =>
  page.evaluate(
    async ([page, plugin, extra]) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("tides", { create: true });
      for (const [name, body] of [["app.html", page], ["tides.js", plugin], ...extra]) {
        const out = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await out.write(body);
        await out.close();
      }
    },
    [PAGE, tides(text), extra],
  );

const shown = (page, selector, ms = 15000) => page.waitForSelector(selector, { timeout: ms }).then(() => true, () => false);
/** Accepts the review card that says `what`; whether it came. */
async function accept(page, what) {
  if (!(await shown(page, `${REVIEW} >> text=${what}`))) return false;
  await page.click(`${REVIEW} >> text="Accept"`);
  return true;
}
/** Whether a file of the app, as this device serves it in the space, comes to pass `test` within a few seconds. */
async function becomes(page, file, test) {
  for (let i = 0; i < 40; i++, await new Promise((r) => setTimeout(r, 250))) if (test(await served(page, file))) return true;
  return false;
}
/** A file of the app as this device serves it in the space. */
const served = (page, file) => page.evaluate((file) => fetch(`/s/home/apps/tides/${file}`).then((r) => (r.ok ? r.text() : `${r.status}`)), file);

export default async function ({ check, context, errors }) {
  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "space-made-apps-"));
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
      await page.goto(`${server.url}/s/home/new/`);
      await page.waitForSelector(`${YOURS} button[data-action="open-folder"]`, { timeout: 15000 });
    }

    // Ann makes the app in the space, from a folder, and shares it.
    await folder(ann.page, "High water at noon");
    await ann.page.click(`${YOURS} button[data-action="open-folder"]`);
    const made = (await accept(ann.page, "makes Tide times")) && (await shown(ann.page, `${YOURS} button[data-action="share"]`));
    check("space made apps: an app made in a space offers to be shared with it", made);
    await ann.page.click(`${YOURS} button[data-action="share"]`);
    const shared = (await accept(ann.page, "shares your app Tide times")) && (await shown(ann.page, `${YOURS} >> text=Shared with the space`));
    check("space made apps: sharing it is a review, and then it is shared", shared);

    // Ben sees it as from the space, and it doesn't run for him until he accepts it.
    const offered = await shown(ben.page, `${YOURS} .shared >> text=Tide times`);
    const by = offered && (await ben.page.isVisible(`${YOURS} .shared >> text=shared by Ann`));
    const before = await served(ben.page, "app.html");
    check("space made apps: another member sees it in their apps, from the space and who shared it, not yet running", offered && by && before === "404", `offered ${offered}, by ${by}, served ${before.slice(0, 40)}`);
    await ben.page.click(`${YOURS} .shared button[data-action="accept"]`);
    const took = await accept(ben.page, "makes Tide times");
    const runs = took && (await shown(ben.page, `${YOURS} button[data-action="pick"]:has-text("Tide times")`)) && (await becomes(ben.page, "tides.js", (t) => /High water at noon/.test(t)));
    const preview = runs && (await ben.page.frameLocator(`${YOURS} ui-preview iframe`).locator("text=High water at noon").waitFor({ timeout: 15000 }).then(() => true, () => false));
    check("space made apps: once they accept its files on a review card, it runs for them, inside the space", runs && preview && (await ben.page.locator(`${YOURS} .shared`).count()) === 0, `took ${took}, runs ${runs}, preview ${preview}`);

    // Ben adds a file of his own to his copy; the space's next version doesn't have it.
    await folder(ben.page, "High water at noon", [["notes.css", "p { color: teal; }"]]);
    await ben.page.click(`${YOURS} button[data-action="open-folder"]`);
    const asked = await accept(ben.page, "your app Tide times: changes notes.css");
    const own = asked && (await becomes(ben.page, "notes.css", (t) => /teal/.test(t)));

    // Ann shares a new version: it reaches Ben the same way, as a whole.
    await folder(ann.page, "High water at one");
    await ann.page.click(`${YOURS} button[data-action="open-folder"]`);
    await accept(ann.page, "your app Tide times: changes tides.js");
    await shown(ann.page, `${YOURS} button[data-action="share"]:has-text("Share this version")`);
    await ann.page.click(`${YOURS} button[data-action="share"]`);
    await accept(ann.page, "shares your app Tide times");
    const update = await shown(ben.page, `${YOURS} .shared >> text=new version`);
    const unchanged = /High water at noon/.test(await served(ben.page, "tides.js"));
    await ben.page.click(`${YOURS} .shared button[data-action="accept"]`).catch(() => {});
    const changed = (await accept(ben.page, "your app Tide times: changes tides.js, and removes notes.css")) && (await becomes(ben.page, "tides.js", (t) => /High water at one/.test(t)));
    const whole = await becomes(ben.page, "notes.css", (t) => t === "404");
    check("space made apps: a new version arrives the same way, to accept before it runs, and replaces the app as a whole", own && update && unchanged && changed && whole, `asked ${asked}, own ${own}, offered ${update}, unchanged ${unchanged}, changed ${changed}, whole ${whole}`);

    // Ann stops sharing it: it leaves the space's list, and Ben keeps his copy.
    await ann.page.click(`${YOURS} button[data-action="unshare"]`);
    const stopped = (await accept(ann.page, "stops sharing tides")) && (await shown(ann.page, `${YOURS} >> text=No longer shared`));
    check("space made apps: stopping sharing leaves a member's accepted copy with them", stopped && /High water at one/.test(await served(ben.page, "tides.js")) && (await ann.page.isVisible(`${YOURS} button[data-action="share"]:has-text("Share with the space")`)));

    // An app Ann made outside the space (at /new/, in her own data folder) can be copied in, after a review.
    await ann.page.evaluate(async ([page, plugin]) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of ["made", "apps", "harbour"]) dir = await dir.getDirectoryHandle(part, { create: true });
      for (const [name, body] of [["app.html", page.replace("Tide times", "Harbour")], ["tides.js", plugin]]) {
        const out = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await out.write(body);
        await out.close();
      }
    }, [PAGE, tides("Boats in")]);
    await ann.page.reload();
    const listed = await shown(ann.page, `${YOURS} .own-apps >> text=Harbour`);
    if (listed) await ann.page.click(`${YOURS} .own-apps button[data-action="copy-in"]`);
    const copied = listed && (await accept(ann.page, "makes Harbour")) && (await shown(ann.page, `${YOURS} button[data-action="pick"]:has-text("Harbour")`));
    const inSpace = copied && (await ann.page.evaluate(() => fetch("/s/home/apps/harbour/tides.js").then((r) => r.text()))).includes("Boats in");
    check("space made apps: an app made outside the space is offered to copy in, and copied after a review", listed && copied && inSpace && (await ann.page.locator(`${YOURS} .own-apps`).count()) === 0, `listed ${listed}, copied ${copied}, served ${inSpace}`);
  } finally {
    for (const device of devices) await device.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true });
  }
}
