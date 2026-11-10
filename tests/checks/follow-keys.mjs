// A person's API keys follow them between devices, encrypted so the site's
// server can never read one (std/follow/vault.ts, std/account/module.ts,
// account/model-keys.js). One person signs in on two devices. On the first
// they give a model its key and, on their account page, protect their keys
// with a passphrase: what the account then keeps holds no key and no
// passphrase. The second device has no key until it is given the passphrase,
// once; a wrong one is refused in words, and nothing arrives. A key given on
// the second reaches the first. A passkey added as another way in unlocks a
// device that has the passkey. Taking the keys out of the account leaves each
// device the keys it has.
import { watchErrors } from "../page-errors.mjs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

const APP = "demos/trip";
const EVERYWHERE = "_everywhere";
const SECRET = "sk-follow-keys-0123456789-first";
const LATER = "sk-follow-keys-9876543210-later";
const PASSPHRASE = "four quiet otters swim";

/** A plugin that asks for a key of the given name as it starts, as a model's plugin does when it is first asked. */
const asker = (name) => `export const manifest = { id: "asks-${name}", name: "Asks ${name}", permissions: ["secret:${name}"] };
export default async (ctx) => {
  if (!(await ctx.call("secrets", "has", "${name}")).set) await ctx.call("secrets", "request", "${name}", { hosts: ["api.example.com"], label: "${name} key" });
};`;

const command = (page, name, arg) => page.evaluate(([n, a]) => window.__host.command(n, a), [name, arg]);
const open = async (page, address) => {
  await page.goto(address);
  await page.waitForFunction(() => window.__host);
};
/** The keys a device has, by name, read from its own data folder. */
const keysOn = (page) =>
  page.evaluate(async () => {
    try {
      const file = await (await (await navigator.storage.getDirectory()).getFileHandle("secrets.json")).getFile();
      return Object.fromEntries(Object.entries(JSON.parse(await file.text())).map(([name, s]) => [name, s.value]));
    } catch {
      return {};
    }
  });
/** Syncs with the account until the device's keys pass `test`. */
async function until(page, test, ms = 20000) {
  let seen = {};
  let status;
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
    status = await command(page, "follow", APP).catch((e) => ({ error: String(e) }));
    seen = await keysOn(page);
    if (test(seen, status)) return { ok: true, seen, status };
  }
  return { ok: false, seen, status };
}
const walk = async (dir, at = "") => (await Promise.all((await readdir(join(dir, at), { withFileTypes: true }).catch(() => [])).map((e) => (e.isDirectory() ? walk(dir, join(at, e.name)) : [join(at, e.name)])))).flat();
/** Everything the server keeps, as one text. */
const everything = async (dir) => (await Promise.all((await walk(dir)).map((path) => readFile(join(dir, path), "utf8").catch(() => "")))).join("\n");

const SECTION = '[data-part="model-keys"]';
const CARD = '[data-key^="secrets:"]';
/** The card the kernel draws for the passphrase, among any a plugin's key has open. */
const PASS = `${CARD}:has-text("passphrase")`;

export default async function ({ check, context, errors }) {
  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "follow-keys-"));
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" });
  const contexts = [];
  /** A device with a passkey authenticator of its own, whose passkeys can derive a key (WebAuthn PRF). */
  const device = async (name) => {
    const own = await browser.newContext();
    contexts.push(own);
    const page = await own.newPage();
    watchErrors(page, errors, `follow-keys ${name}`);
    const cdp = await own.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    return { own, page, cdp, authenticatorId };
  };
  /** Types into the card the kernel draws for a passphrase, and saves it. */
  const type = async (page, ...typed) => {
    await page.waitForSelector(`${PASS} input[type=password]`, { timeout: 15000 });
    const fields = page.locator(`${PASS} input[type=password]`);
    for (let i = 0; i < typed.length; i++) await fields.nth(i).fill(typed[i]);
    await page.click(`${PASS} button:has-text("Save")`);
  };
  const said = (page) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() ?? "", SECTION);
  try {
    // Ann signs in on her first device and gives a model its key.
    const first = await device("first device");
    await first.page.goto(`${server.url}/account/`);
    await first.page.fill('form[data-action="register"] input[name="name"]', "Ann");
    await first.page.click('form[data-action="register"] button[type="submit"]');
    await first.page.waitForSelector(".signed-in", { timeout: 8000 });
    await first.page.waitForSelector(SECTION, { timeout: 15000 }).catch(() => {});
    const offered = await said(first.page);

    await open(first.page, `${server.url}/${APP}/app.html`);
    await command(first.page, "user:add", { app: EVERYWHERE, files: [{ name: "asks-first-model.js", data: asker("first-model") }] });
    await command(first.page, "user:on", { app: EVERYWHERE, id: "asks-first-model" });
    await first.page.waitForSelector(`${CARD} input[type=password]`, { timeout: 15000 }).catch(() => {});
    await first.page.fill(`${CARD} input[type=password]`, SECRET).catch(() => {});
    await first.page.click(`${CARD} button:has-text("Save")`).catch(() => {});
    const before = await until(first.page, (keys, status) => keys["first-model"] === SECRET && status?.on && !!status.at);
    // Off again, as a model's plugin asks only when it is used: it goes to her other devices off.
    await command(first.page, "user:off", { app: EVERYWHERE, id: "asks-first-model" });
    const plainBefore = await everything(spaces);
    check(
      "keys: until a person asks, a key stays on its device: the account page offers to have keys follow them, and the server has nothing of the key",
      before.ok && before.status.keys === "off" && /stay on this device/.test(offered) && /Protect them with a passphrase/.test(offered) && !plainBefore.includes(SECRET),
      JSON.stringify([before.status, offered]),
    );

    // She protects her keys with a passphrase: typed twice, into the kernel's card.
    await first.page.goto(`${server.url}/account/`);
    await first.page.click(`${SECTION} button[data-action="protect-passphrase"]`);
    await type(first.page, PASSPHRASE, "four quiet otters swam");
    const mismatch = await first.page.waitForSelector(`${PASS} :text("aren't the same")`, { timeout: 8000 }).then(() => true, () => false);
    await type(first.page, PASSPHRASE, PASSPHRASE);
    const protectedNow = await first.page.waitForSelector(`${SECTION} :text("Your model keys follow you")`, { timeout: 20000 }).then(() => true, () => false);
    await open(first.page, `${server.url}/${APP}/app.html`);
    const sent = await until(first.page, (_keys, status) => status?.keys === "on" && !status.error);
    const kept = await walk(join(spaces, "_accounts", "follow"));
    const index = JSON.parse(await readFile(join(spaces, "_accounts", "follow", kept.find((p) => p.endsWith("index.json")) ?? "none"), "utf8").catch(() => "{}"));
    const names = Object.keys(index.items ?? {}).filter((k) => /^(key|vault):/.test(k)).sort();
    const stored = await everything(spaces);
    check(
      "keys: protected with a passphrase typed twice (two that differ are refused), her key goes to her account, and nothing the server keeps holds the key or the passphrase",
      mismatch && protectedNow && sent.ok && names.join() === "key:first-model,vault:pass" && !stored.includes(SECRET) && !stored.includes(PASSPHRASE) && !stored.includes(Buffer.from(SECRET).toString("base64").slice(0, 20)),
      JSON.stringify([mismatch, protectedNow, sent.status, names]),
    );

    // Her second device: signed in, it has no key until it is given the passphrase.
    const second = await device("second device");
    await second.own.addCookies(await first.own.cookies());
    await second.page.goto(`${server.url}/account/`);
    await second.page.waitForSelector(".signed-in", { timeout: 8000 });
    const locked = await second.page.waitForSelector(`${SECTION} button[data-action="unlock-passphrase"]`, { timeout: 20000 }).then(() => true, () => false);
    await open(second.page, `${server.url}/${APP}/app.html`);
    const waiting = await until(second.page, (_keys, status) => status?.keys === "locked", 15000);
    await second.page.click("ui-panel .launch");
    const hint = await second.page.waitForSelector('[data-part="keys-locked"] a[href="/account/"]', { timeout: 15000 }).then(() => true, () => false);
    check("keys: a second device has no key until it is unlocked, and Customize and her account page both say where to unlock them", locked && waiting.ok && !Object.keys(waiting.seen).length && hint, JSON.stringify([locked, waiting.status, waiting.seen, hint]));

    await second.page.goto(`${server.url}/account/`);
    await second.page.click(`${SECTION} button[data-action="unlock-passphrase"]`);
    await type(second.page, "four quiet otters sink");
    const wrong = await second.page.waitForSelector(`${SECTION} [role="alert"]:text("didn't unlock your keys")`, { timeout: 20000 }).then(() => true, () => false);
    const none = await keysOn(second.page);
    await second.page.click(`${SECTION} button[data-action="unlock-passphrase"]`);
    await type(second.page, PASSPHRASE);
    const opened = await second.page.waitForSelector(`${SECTION} :text("Your model keys follow you")`, { timeout: 20000 }).then(() => true, () => false);
    await open(second.page, `${server.url}/${APP}/app.html`);
    const arrived = await until(second.page, (keys) => keys["first-model"] === SECRET);
    // The plugin that asks for that key came from her account too: turned on, with the key here it has nothing to ask.
    await command(second.page, "user:on", { app: EVERYWHERE, id: "asks-first-model" });
    await second.page.waitForFunction(() => window.__host.traces.some((e) => e.name === "user-plugin:on" && e.plugin === "asks-first-model"), null, { timeout: 10000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const asked = await second.page.locator(CARD).count();
    check("keys: a wrong passphrase is refused in words and brings nothing; the right one, once, brings her key, and nothing asks for it again", wrong && !Object.keys(none).length && opened && arrived.ok && asked === 0, JSON.stringify([wrong, none, opened, Object.keys(arrived.seen), arrived.status, asked]));

    // In a space her keys are there too.
    await first.page.goto(`${server.url}/account/`);
    await first.page.fill('form[data-action="make"] input[name="name"]', "home");
    await first.page.click('form[data-action="make"] button[type="submit"]');
    await first.page.waitForSelector('.space-list button:has-text("Invite someone")', { timeout: 8000 }).catch(() => {});
    await open(second.page, `${server.url}/s/home/${APP}/`);
    const inSpace = await second.page
      .waitForFunction(
        async () => {
          await window.__host.command("follow", "demos/trip").catch(() => {});
          try {
            let dir = await navigator.storage.getDirectory();
            for (const part of ["spaces", "home"]) dir = await dir.getDirectoryHandle(part);
            return (await (await (await dir.getFileHandle("secrets.json")).getFile()).text()).includes("first-model");
          } catch {
            return false;
          }
        },
        null,
        { timeout: 20000, polling: 500 },
      )
      .then(() => true, () => false);
    check("keys: opening a space on an unlocked device brings her keys there with no card", inSpace && (await second.page.locator(CARD).count()) === 0);

    // A key given on the second device reaches the first.
    await open(second.page, `${server.url}/${APP}/app.html`);
    await command(second.page, "user:add", { app: EVERYWHERE, files: [{ name: "asks-later-model.js", data: asker("later-model") }] });
    await command(second.page, "user:on", { app: EVERYWHERE, id: "asks-later-model" });
    await second.page.waitForSelector(`${CARD} input[type=password]`, { timeout: 15000 }).catch(() => {});
    await second.page.fill(`${CARD} input[type=password]`, LATER).catch(() => {});
    await second.page.click(`${CARD} button:has-text("Save")`).catch(() => {});
    await until(second.page, (keys, status) => keys["later-model"] === LATER && !status?.error, 10000);
    await open(first.page, `${server.url}/${APP}/app.html`);
    const back = await until(first.page, (keys) => keys["later-model"] === LATER && keys["first-model"] === SECRET);
    const storedLater = await everything(spaces);
    check("keys: a key given on the second device reaches the first, and the server still holds neither", back.ok && !storedLater.includes(LATER) && !storedLater.includes(SECRET), JSON.stringify(Object.keys(back.seen)));

    // She adds her passkey as another way in. A device that has that passkey and not the unlocked keys (here, the
    // first with what it unlocked taken away) unlocks with it, nothing typed.
    await first.page.goto(`${server.url}/account/`);
    await first.page.click(`${SECTION} button[data-action="protect-passkey"]`);
    const both = await first.page.waitForSelector(`${SECTION} button[data-action="protect-passkey"]`, { state: "detached", timeout: 20000 }).then(() => true, () => false);
    await first.page.evaluate(() => new Promise((done) => (indexedDB.deleteDatabase("follow-vault").onsuccess = done)));
    await first.page.reload();
    const relocked = await first.page.waitForSelector(`${SECTION} button[data-action="unlock-passkey"]`, { timeout: 20000 }).then(() => true, () => false);
    await first.page.click(`${SECTION} button[data-action="unlock-passkey"]`).catch(() => {});
    const byPasskey = await first.page.waitForSelector(`${SECTION} :text("Your model keys follow you")`, { timeout: 20000 }).then(() => true, () => false);
    const firstSaid = await said(first.page);
    await open(first.page, `${server.url}/${APP}/app.html`);
    const again = await until(first.page, (keys, status) => status?.keys === "on" && keys["first-model"] === SECRET && keys["later-model"] === LATER);
    const storedLast = await everything(spaces);
    check("keys: a passkey added as another way in unlocks a device that has that passkey, with nothing typed, and the server holds no key", both && relocked && byPasskey && again.ok && !storedLast.includes(SECRET) && !storedLast.includes(LATER), JSON.stringify([both, relocked, byPasskey, Object.keys(again.seen), again.status, firstSaid]));

    // Taking the keys out of the account leaves each device what it has.
    await second.page.goto(`${server.url}/account/`);
    await second.page.click(`${SECTION} button[data-action="remove"]`);
    await second.page.click(`${SECTION} button[data-action="remove-yes"]`);
    const out = await second.page.waitForSelector(`${SECTION} button[data-action="protect-passphrase"]`, { timeout: 20000 }).then(() => true, () => false);
    const left = JSON.parse(await readFile(join(spaces, "_accounts", "follow", kept.find((p) => p.endsWith("index.json")) ?? "none"), "utf8").catch(() => "{}"));
    const remaining = Object.entries(left.items ?? {}).filter(([k, e]) => /^(key|vault):/.test(k) && !e.gone).map(([k]) => k);
    const off = await until(first.page, (_keys, status) => status?.keys === "off");
    check("keys: taken out of her account, nothing of them is kept there, and each device keeps the keys it has", out && !remaining.length && off.ok && off.seen["first-model"] === SECRET && off.seen["later-model"] === LATER, JSON.stringify([out, remaining, off.status, Object.keys(off.seen)]));
  } finally {
    for (const own of contexts) await own.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true }).catch(() => {});
  }
}
