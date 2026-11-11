// Notifications with every tab closed (Web Push), in a real browser: Ann
// turns notifications on for her device on her account page, sends herself a
// test, and gets what the household's space says when a chore comes due
// (demos/household/reminders.js, on the space's server), shown by the site's
// service worker (sw/push.js) with no tab of the site open.
//
// A browser's subscription is with its vendor's push service, which a test
// browser usually can't reach or isn't given by its build. So the check first
// asks the browser for a real one and says whether it got it; then, so the
// rest never depends on the outside world, it stands in for the push service:
// the page is handed a subscription whose address is a server on this machine
// (tests/server/push.mjs), the check reads what the site's server sent there
// as the browser would (decrypting it with the subscription's keys), and
// hands it to the service worker the way a push service does, with the
// browser's own "a push arrived" (DevTools' ServiceWorker.deliverPushMessage).
// Everything else is the real thing: the account page, the server's routes
// and key, the encryption, the service worker, the notification it shows.
// The routes on both hosts: tests/server/push.mjs.
//
// The run's own browser is Chromium's headless shell, which refuses every
// notification, so this starts full Chromium in its new headless mode.

import { watchErrors } from "../page-errors.mjs";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";
import { fakePushService, subscription } from "../server/push.mjs";

const require = createRequire(import.meta.url);
const CARD = '[data-key^="account-notifications"]';
const CHORES = '[data-key="chores:list"]';

const text = (page, selector) => page.locator(selector).first().textContent({ timeout: 8000 }).then((t) => (t ?? "").replace(/\s+/g, " ").trim(), () => "");
const until = async (ask, ms = 15000) => {
  let seen;
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) if ((seen = await ask())) return seen;
  return seen;
};

/** In the page: a push manager whose subscription is the stand-in's, kept across pages as a browser keeps its own. */
function standIn(sub) {
  const KEY = "check-push-subscription";
  const made = (key) => ({
    endpoint: sub.endpoint,
    options: { userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer },
    toJSON: () => sub,
    unsubscribe: async () => (localStorage.removeItem(KEY), true),
  });
  if (!("PushManager" in window)) return;
  PushManager.prototype.getSubscription = async () => (localStorage.getItem(KEY) ? made(localStorage.getItem(KEY)) : null);
  PushManager.prototype.subscribe = async (options) => {
    const key = btoa(String.fromCharCode(...new Uint8Array(options.applicationServerKey))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    localStorage.setItem(KEY, key);
    return made(key);
  };
}

export default async function ({ check, errors }) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ channel: "chromium" });
  const service = await fakePushService();
  const spaces = await mkdtemp(join(tmpdir(), "push-closed-"));
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js", pushHosts: [service.origin] });
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await context.grantPermissions(["notifications"], { origin: server.url });
    // A page that isn't the site's stays open only so the check can speak to the browser: every tab of the site closes.
    const outside = await context.newPage();
    const cdp = await context.newCDPSession(outside);
    const registrations = new Map();
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations: list }) => list.forEach((r) => (r.isDeleted ? registrations.delete(r.registrationId) : registrations.set(r.registrationId, r.scopeURL))));
    await cdp.send("ServiceWorker.enable");

    const page = await context.newPage();
    watchErrors(page, errors, "push-closed-tabs");
    const keys = await context.newCDPSession(page);
    await keys.send("WebAuthn.enable");
    await keys.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`${server.url}/account/`);
    await page.fill('form[data-action="register"] input[name="name"]', "Ann");
    await page.click('form[data-action="register"] button[type="submit"]');
    await page.waitForSelector(".signed-in", { timeout: 8000 });
    await page.waitForSelector(`${CARD} button[data-action="on"]`, { timeout: 8000 }).catch(() => {});
    const offered = await text(page, CARD);
    check("push: someone signed in is offered notifications on this device, and told what they are for", /Notifications on this device/.test(offered) && /when you don't have them open/.test(offered) && /Turn on for this device/.test(offered), offered);

    // Whether this browser can make a real subscription, with its vendor's push service. Said, not required.
    const real = await page.evaluate(async () => {
      const made = (async () => {
        const registration = await navigator.serviceWorker.ready;
        const { key } = await (await fetch("/auth/push")).json();
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)) });
        const host = new URL(subscription.endpoint).host;
        await subscription.unsubscribe();
        return `yes, with ${host}`;
      })().catch((error) => `no: ${error.message}`);
      return Promise.race([made, new Promise((r) => setTimeout(() => r("no: its push service didn't answer in 8 seconds"), 8000))]);
    });
    check(`push: (this browser makes a real subscription: ${real})`, true);

    const device = await subscription(service, "ann-browser");
    await context.addInitScript(standIn, device.json);
    await page.reload();
    await page.waitForSelector(`${CARD} button[data-action="on"]`, { timeout: 15000 });
    await page.click(`${CARD} button[data-action="on"]`);
    await page.waitForSelector(`${CARD} button[data-action="test"]`, { timeout: 8000 }).catch(() => {});
    const on = await text(page, CARD);
    check("push: turning notifications on adds this device to the person's account, and says so", /Notifications are on for this device/.test(on) && /Chrome on \w+ \(this one\)/.test(on) && /Send me a test/.test(on) && /Turn off for this device/.test(on), on);
    if (process.env.SHOTS) {
      await page.locator(CARD).first().scrollIntoViewIfNeeded().catch(() => {});
      await page.screenshot({ path: `${process.env.SHOTS}/account-notifications-desktop.png` }).catch(() => {});
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator(CARD).first().scrollIntoViewIfNeeded().catch(() => {});
      await page.screenshot({ path: `${process.env.SHOTS}/account-notifications-phone.png` }).catch(() => {});
      await page.setViewportSize({ width: 1100, height: 900 });
    }

    /** Hands the service worker what the site's server sent this device, as its push service would. */
    const delivered = new Set();
    const deliver = async (title) => {
      const note = await until(async () => (await device.notes()).find((n) => title.test(n.title ?? "") && !delivered.has(n.title)));
      if (!note) return null;
      delivered.add(note.title);
      const { headers, ...data } = note;
      const [registrationId] = [...registrations].find(([, scope]) => scope === `${server.url}/`) ?? [];
      await cdp.send("ServiceWorker.deliverPushMessage", { origin: server.url, registrationId, data: JSON.stringify(data) });
      return note;
    };
    /** The notifications the service worker is showing, asked from a page opened for it. */
    const showing = async () => {
      const asker = await context.newPage();
      await asker.goto(`${server.url}/404-nothing-here`).catch(() => {});
      const list = await asker.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, url: n.data?.url, app: n.data?.app })));
      await asker.close();
      return list;
    };

    await page.click(`${CARD} button[data-action="test"]`);
    await page.waitForSelector(`${CARD} .status:has-text("on its way")`, { timeout: 8000 }).catch(() => {});
    const testSaid = await text(page, `${CARD} .status`);
    const test = await deliver(/reach this device/);
    const tested = await until(async () => (await showing()).find((n) => /reach this device/.test(n.title)), 8000);
    check("push: a test from the account page arrives as a notification that opens the account page", /on its way/.test(testSaid) && test && tested?.url === "/account/" && /Hello Ann/.test(tested.body ?? ""), JSON.stringify({ testSaid, test: test && { ...test, headers: undefined }, tested }));

    // A household in a space, with a chore last done nine days ago and due weekly: it came due two days ago.
    await page.fill('form[data-action="make"] input[name="name"]', "den");
    await page.click('form[data-action="make"] button[type="submit"]');
    await page.waitForSelector('.space-list button:has-text("Invite a reader")', { timeout: 8000 });
    await page.goto(`${server.url}/s/den/demos/household/`);
    await page.waitForSelector(`${CHORES} form`, { timeout: 15000 });
    await until(() => page.evaluate(() => window.__host.command("sync")).then((s) => s?.access?.role === "owner", () => false));
    const doneOn = new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10);
    await page.evaluate((doneOn) => window.__host.command("install", `export const manifest = { id: "old-chore", name: "An old chore", permissions: ["data:write:chores"] };\nexport default async (ctx) => { await ctx.call("data", "put", "chores", { id: "recycling", name: "Put the recycling out", every: 7, doneOn: ${JSON.stringify(doneOn)} }, "test"); };`), doneOn);
    // The kernel asks before a new plugin starts, as it does for anyone.
    if (await page.locator('[data-key^="review:"] >> text=/An old chore/').first().waitFor({ timeout: 10000 }).then(() => true, () => false)) await page.click('[data-key^="review:"] >> text="Accept"');
    const listed = await page.locator(`${CHORES} li`, { hasText: "Put the recycling out" }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    // The space's server hears the change and sends the reminder; the push service holds it for the device.
    const held = await until(async () => (await device.notes()).find((n) => /recycling/.test(n.title ?? "")), 20000);

    // Every tab of the site closes. Only then does the push reach the browser.
    await page.close();
    const open = context.pages().filter((p) => p.url().startsWith(server.url)).length;
    const reminder = await deliver(/Put the recycling out is due/);
    const shown = await until(async () => (await showing()).find((n) => /recycling/.test(n.title)), 8000);
    check(
      "push: a chore that came due in a space is told to its members, and the notification shows with every tab of the site closed",
      listed && held && open === 0 && reminder && shown?.title === "Put the recycling out is due" && shown.url === "/s/den/demos/household/" && shown.app === "/s/den/demos/household/",
      JSON.stringify({ listed, held: held && { ...held, headers: undefined }, open, shown }),
    );

    // Said once: the space starting again, or the chores changing, doesn't say it a second time.
    const again = await context.newPage();
    watchErrors(again, errors, "push-closed-tabs");
    await again.goto(`${server.url}/s/den/demos/household/`);
    await again.waitForSelector(`${CHORES} form`, { timeout: 15000 });
    await again.fill(`${CHORES} form input[name="name"]`, "Sweep the yard");
    await again.click(`${CHORES} form button[type="submit"]`);
    await again.locator(`${CHORES} li`, { hasText: "Sweep the yard" }).first().waitFor({ timeout: 8000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    const count = (await device.notes()).filter((n) => /recycling|chores are due/.test(n.title ?? "")).length;
    check("push: a chore's reminder is sent once for each time it comes due", count === 1, `${count} sent`);

    // Turning it off takes the device away, and nothing more is sent to it.
    await again.goto(`${server.url}/account/`);
    await again.waitForSelector(`${CARD} button[data-action="off"]`, { timeout: 15000 });
    await again.click(`${CARD} button[data-action="off"]`);
    await again.waitForSelector(`${CARD} button[data-action="on"]`, { timeout: 8000 }).catch(() => {});
    const off = await text(again, CARD);
    const left = await again.evaluate(async () => (await (await fetch("/auth/push")).json()).devices.length);
    check("push: turning notifications off takes this device away from the account", /Notifications are off for this device/.test(off) && !/this one/.test(off) && left === 0, JSON.stringify({ off, left }));
  } finally {
    await browser.close();
    await server.stop();
    service.close();
    await rm(spaces, { recursive: true, force: true });
  }
}
