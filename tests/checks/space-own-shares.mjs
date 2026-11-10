// Sharing more of your own with a space (std/spaces/plugins.ts, src/kernel/authoring.ts):
// an agent a member added (an .agent.md file) and a plugin they use in every
// app are shared from Customize through the same review as any plugin. The
// other member gets each turned off, as the space's. For the every-app
// plugin the space gets a copy for that app, and the member's own stays in
// every app they open.
import { watchErrors } from "../page-errors.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

const APP = "demos/reading-list";
const OTHER = "demos/habits";
const EVERYWHERE = "_everywhere";
const FORM = '[data-key="library:books"] ui-form';
const AGENT = `---
id: shelf-helper
name: Shelf helper
description: Answers what you write to it about the shelf.
permissions: []
on:
  - message: true
---
You answer in one short line.
`;
const NOTE = 'export const manifest = { id: "every-note", name: "Every note", description: "A note in every app.", permissions: [] };\nexport default () => {};';

async function signUp(browser, address, name, errors) {
  const context = await browser.newContext();
  const page = await context.newPage();
  watchErrors(page, errors, `space-own-shares ${name}`);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(address);
  await page.fill('form[data-action="register"] input[name="name"]', name);
  await page.click('form[data-action="register"] button[type="submit"]');
  await page.waitForSelector(".signed-in", { timeout: 8000 });
  return { context, page };
}

const command = (page, name, arg) => page.evaluate(([n, a]) => window.__host.command(n, a), [name, arg]);
const list = (page, app = APP) => command(page, "user:list", { app }).then((l) => (Array.isArray(l) ? l : []), () => []);
async function until(page, test, ms = 15000) {
  let seen = [];
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
    seen = await list(page);
    if (test(seen)) return { ok: true, seen };
  }
  return { ok: false, seen };
}

export default async function ({ check, context, errors }) {
  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "space-own-shares-"));
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" });
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
    for (const { page } of [ann, ben]) {
      await page.goto(`${server.url}/s/home/${APP}/`);
      await page.waitForSelector(FORM, { timeout: 15000 });
    }

    // Ann's agent, and a plugin she uses in every app.
    const agent = await command(ann.page, "user:add", { app: APP, files: [{ name: "shelf-helper.agent.md", data: AGENT }] });
    const note = await command(ann.page, "user:add", { app: EVERYWHERE, files: [{ name: "every-note.js", data: NOTE }] });
    await command(ann.page, "user:on", { app: EVERYWHERE, id: "every-note" });

    await ann.page.click("ui-panel .launch");
    const share = async (id) => {
      const button = ann.page.locator(`button[data-share="${id}"]`);
      await button.waitFor({ timeout: 8000 });
      await button.click();
      const card = await ann.page.waitForSelector('[data-key^="review:"]', { timeout: 8000 }).then((c) => c.textContent(), () => "");
      await ann.page.click('[data-key^="review:"] >> text=Accept', { timeout: 8000 }).catch(() => {});
      await ann.page.locator(`button[data-share="${id}"]`, { hasText: "Stop sharing" }).waitFor({ timeout: 8000 }).catch(() => {});
      return (card ?? "").replace(/\s+/g, " ");
    };

    const agentCard = await share("shelf-helper");
    const got = await until(ben.page, (l) => l.some((p) => p.id === "shelf-helper"));
    const bens = got.seen.find((p) => p.id === "shelf-helper");
    check(
      "space shares: an agent of hers is shared from Customize through a review that says what it is, and reaches the other member turned off, as the space's",
      agent?.ok && /this agent/.test(agentCard) && /their own key/.test(agentCard) && got.ok && bens?.on === false && bens?.shared === true && /\.agent\.md$/.test(bens?.file ?? ""),
      JSON.stringify({ agent, card: agentCard.slice(0, 200), bens }),
    );

    const noteCard = await share("every-note");
    const gotNote = await until(ben.page, (l) => l.some((p) => p.id === "every-note"));
    const bensNote = gotNote.seen.find((p) => p.id === "every-note");
    const here = (await list(ann.page)).find((p) => p.id === "every-note");
    const elsewhere = (await list(ann.page, OTHER)).find((p) => p.id === "every-note");
    check(
      "space shares: a plugin she uses in every app is shared as a copy for this app; the other member gets it off, and hers stays in every app",
      note?.ok && /yours stays in every app/.test(noteCard) && gotNote.ok && bensNote?.on === false && bensNote?.shared === true && here?.shared === true && here?.on === true && !here?.everywhere && elsewhere?.everywhere === true && elsewhere?.on === true,
      JSON.stringify({ card: noteCard.slice(0, 200), bensNote, here, elsewhere }),
    );

    // Stopping takes the agent from Ben and leaves it with her.
    await command(ann.page, "user:unshare", { app: APP, id: "shelf-helper" });
    const taken = await until(ben.page, (l) => !l.some((p) => p.id === "shelf-helper"));
    const keeps = (await list(ann.page)).find((p) => p.id === "shelf-helper");
    check("space shares: stopping sharing an agent takes it from the other member and leaves it with its owner", taken.ok && keeps?.shared === false, JSON.stringify({ ben: taken.seen.map((p) => p.id), keeps }));
  } finally {
    for (const device of devices) await device.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true });
  }
}
