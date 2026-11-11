// A model key a space holds for its members, in a real browser
// (std/spaces/model-key.ts, std/llm/space.js, account/space-model.js): the
// space's owner gives the key on their account page, into a card the kernel
// draws; a member with no key of their own is offered the space's model by
// Ask the page, is shown whose key pays, and gets an answer; and the key is
// in nothing the member's browser was sent. Outside a space, or in a space
// with no key, the model isn't offered at all. The vendor is a stand-in
// (tests/server/space-model.mjs), reached through the server's gateways.
import { watchErrors } from "../page-errors.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";
import { fakeModel, KEY } from "../server/space-model.mjs";

const APP = "demos/reading-list";
const FORM = '[data-key="library:books"] ui-form';
const SECTION = '[data-part="space-model"]';
const CARD = '[data-key^="secrets:"]';
const REVIEW = '[data-key^="review:"]';
const ASK = '[data-key^="ask-the-page@"]';

async function signUp(browser, address, name, errors) {
  const context = await browser.newContext();
  const page = await context.newPage();
  watchErrors(page, errors, `space-model ${name}`);
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

const seen = (page, selector, timeout = 10000, state = "visible") => page.waitForSelector(selector, { timeout, state }).then(() => true, () => false);
const textOf = async (page, selector) => ((await page.textContent(selector).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();

/** Adds Ask the page from Customize, as a person would, and closes the panel. */
async function addAsk(page) {
  await page.click("ui-panel .launch");
  await page.waitForSelector('[data-package="ask-the-page"]', { timeout: 10000 });
  await page.click('[data-package="ask-the-page"]');
  await page.waitForSelector(`${REVIEW} >> text=adds Ask the page`, { timeout: 15000 });
  await page.click(`${REVIEW} button:has-text("Accept")`);
  await page.waitForSelector('[data-toggle="ask-the-page"]:has-text("Turn off")', { timeout: 10000 });
  await page.click("ui-panel .close, ui-panel [data-action='panel']").catch(() => page.keyboard.press("Escape"));
  await page.waitForSelector(ASK, { timeout: 10000 });
}

export default async function ({ check, context, errors }) {
  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "space-model-"));
  const vendor = await fakeModel();
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js", allowPrivate: ["127.0.0.1"], modelGateways: vendor.gateways });
  const devices = [];
  try {
    const ann = await signUp(browser, `${server.url}/account/`, "Ann", errors);
    devices.push(ann.context);
    await ann.page.fill('form[data-action="make"] input[name="name"]', "home");
    await ann.page.click('form[data-action="make"] button[type="submit"]');
    await ann.page.waitForSelector('.space-list button:has-text("Invite someone")', { timeout: 8000 });
    await ann.page.click('.space-list button:has-text("Invite someone")');
    await ann.page.waitForSelector(".invite input", { timeout: 8000 });
    const ben = await signUp(browser, await ann.page.inputValue(".invite input"), "Ben", errors);
    devices.push(ben.context);
    // Everything Ben's browser is sent from here on: each response's body and headers, and each socket frame.
    const got = [];
    ben.context.on("response", async (response) => got.push(JSON.stringify(await response.allHeaders().catch(() => ({}))), await response.text().catch(() => "")));
    ben.page.on("websocket", (ws) => ws.on("framereceived", (frame) => got.push(String(frame.payload))));

    // Before the space has a key: its owner is offered to give one, a member's page has no section for it, and Ask the page doesn't offer the space's model.
    const offered = await seen(ann.page, `${SECTION} form[data-action="give:home"] select option[value="anthropic"]`, 10000, "attached");
    const before = await textOf(ann.page, SECTION);
    check("space model: the owner's account page offers to give a space a model key, and says the server keeps it and who pays", offered && /never sent to a browser/.test(before) && /You pay for what the members ask/.test(before) && /No model key/.test(before), before.slice(0, 300));
    await ben.page.goto(`${server.url}/account/`);
    await ben.page.waitForSelector(".space-list", { timeout: 8000 });
    check("space model: a member who owns no space isn't offered it", !(await seen(ben.page, SECTION, 1500)));
    await ben.page.goto(`${server.url}/s/home/${APP}/`);
    await ben.page.waitForSelector(FORM, { timeout: 15000 });
    await addAsk(ben.page);
    const early = !(await seen(ben.page, `${ASK} [data-action="model:llm-space"]`, 2500));
    check("space model: in a space with no key, Ask the page doesn't offer the space's model", early, (await textOf(ben.page, ASK)).slice(0, 300));

    // Ann gives the key: typed into the kernel's card, never into the plugin's own view.
    await ann.page.selectOption(`${SECTION} select[name="vendor"]`, "anthropic");
    await ann.page.click(`${SECTION} form[data-action="give:home"] button[type="submit"]`);
    await ann.page.waitForSelector(`${CARD} input[type=password]`, { timeout: 8000 });
    const card = await textOf(ann.page, CARD);
    await ann.page.fill(`${CARD} input[type=password]`, KEY);
    await ann.page.click(`${CARD} button:has-text("Save")`);
    const given = await seen(ann.page, `${SECTION} >> text=/Its members ask Claude on the key you gave/`);
    const traced = await ann.page.evaluate(() => JSON.stringify(window.__host.traces));
    const shown = await ann.page.content();
    check(
      "space model: the key is typed into a card the kernel draws, which says where it goes; afterwards the page shows the space has a key, and neither the page nor the trace holds it",
      given && /A Claude key for home/.test(card) && /never sent back to a browser/.test(card) && !traced.includes(KEY) && !shown.includes(KEY),
      `${card.slice(0, 200)} | ${(await textOf(ann.page, SECTION)).slice(-300)}`,
    );

    // Ben, who has no key: the space's model is now offered, he is shown whose key pays, and gets an answer.
    await ben.page.reload();
    await ben.page.waitForSelector(FORM, { timeout: 15000 });
    const now = await seen(ben.page, `${ASK} [data-action="model:llm-space"]`, 15000);
    check("space model: once the space has a key, Ask the page offers the space's model to a member with no model", now, (await textOf(ben.page, ASK)).slice(0, 300));
    await ben.page.click(`${ASK} [data-action="model:llm-space"]`);
    await ben.page.waitForSelector(`${REVIEW} >> text=adds The space's model`, { timeout: 15000 });
    const adding = await textOf(ben.page, REVIEW);
    await ben.page.click(`${REVIEW} button:has-text("Accept")`);
    await ben.page.waitForSelector(REVIEW, { state: "detached", timeout: 10000 }).catch(() => {});
    const listed = await seen(ben.page, `${ASK} option[value="llm-space"]`, 10000, "attached");
    check("space model: adding it shows what it may do in words, and it is then one of the app's models, named for whose key it is", listed && /on the key this space's owner gave it/.test(adding) && /Claude, on Ann's key/.test(await textOf(ben.page, `${ASK} option[value="llm-space"]`)), `${adding.slice(0, 300)} | ${await textOf(ben.page, ASK)}`.slice(0, 600));

    const sentBefore = vendor.asked.length;
    await ben.page.fill(`${ASK} input[name="question"]`, "Which book is longest?");
    await ben.page.click(`${ASK} button[type="submit"]`);
    const paying = await seen(ben.page, `${REVIEW} >> text=/asks Claude on Ann's key/`, 15000);
    const pays = await textOf(ben.page, REVIEW);
    check("space model: before his first question goes, the member is shown whose key pays and how many he may ask", paying && /Ann pays for (each question|what you ask)/.test(pays) && /200 a day/.test(pays) && /Always allow in home, on Ann's key/.test(pays) && vendor.asked.length === sentBefore, pays.slice(0, 400));
    await ben.page.click(`${REVIEW} button:has-text("Always allow")`).catch(() => ben.page.click(`${REVIEW} button:has-text("Accept")`));
    const answered = await seen(ben.page, `${ASK} .answer >> text=/You said: Which book is longest/`, 20000);
    const said = `${await textOf(ben.page, `${ASK} .answer`)} ${await textOf(ben.page, `${ASK} .error`)}`;
    check("space model: a member with no key gets an answer through the space's key", answered && vendor.keys.at(-1) === KEY, said.slice(0, 300));
    check("space model: and no card asked him for a key", !(await ben.page.isVisible(CARD).catch(() => false)) && !/API key/i.test(said));

    // Nothing Ben's browser was sent, kept or traced holds the key.
    await new Promise((r) => setTimeout(r, 500));
    const kept = await ben.page.evaluate(async () => {
      const out = [JSON.stringify(window.__host.traces), JSON.stringify({ ...localStorage })];
      const walk = async (dir) => {
        for await (const [, handle] of dir.entries()) {
          if (handle.kind === "directory") await walk(handle);
          else out.push(await (await handle.getFile()).text().catch(() => ""));
        }
      };
      await walk(await navigator.storage.getDirectory()).catch(() => {});
      return out.join("\n");
    });
    check("space model: the key is in nothing the member's browser was sent, keeps or traced", got.length > 10 && !got.some((text) => text.includes(KEY)) && !kept.includes(KEY), `${got.length} things received, ${got.filter((t) => t.includes(KEY)).length} with the key`);

    // The owner sees who asked; and outside a space the model isn't offered.
    await ann.page.reload();
    const used = await seen(ann.page, `${SECTION} >> text=/Ben: 1 question/`, 10000);
    check("space model: its owner sees on their account page what each member asked today", used, (await textOf(ann.page, SECTION)).slice(-300));
    const alone = await browser.newContext();
    devices.push(alone);
    const outside = await alone.newPage();
    watchErrors(outside, errors, "space-model outside");
    await outside.goto(`${server.url}/${APP}/app.html`);
    await outside.waitForSelector(FORM, { timeout: 15000 });
    await addAsk(outside);
    const anyModel = await seen(outside, `${ASK} [data-action^="model:"]`, 10000);
    check("space model: outside a space it isn't offered, while the other models are", anyModel && !(await outside.isVisible(`${ASK} [data-action="model:llm-space"]`).catch(() => false)), (await textOf(outside, ASK)).slice(0, 300));
  } finally {
    for (const device of devices) await device.close().catch(() => {});
    await server.stop();
    vendor.close();
    await rm(spaces, { recursive: true, force: true });
  }
}
