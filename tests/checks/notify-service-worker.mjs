// The notify service's notifications come from the service worker
// (src/host/bridges/notify.ts, sw/notifications.js), so they stay in the
// system's notification centre after every tab of the app closes, and a click
// on one opens the app again at the address it came from, and only ever an
// address on this site. A made app (sw/routes/made.js) with a plugin that
// notifies on a click stands in for the Markdown editor's writer finishing.
//
// The run's own browser is Chromium's headless shell, which refuses every
// notification, so this check starts full Chromium in its new headless mode,
// where a granted permission is kept (Playwright installs both).

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notifier</title><link rel="stylesheet" href="/platform/host.css"><script type="module" src="/platform/host.js"></script><link rel="plugin" href="notifier.js"></head><body><main><slot name="main"></slot></main></body></html>';

const PLUGIN = `export const manifest = {
  id: "notify-sw",
  name: "Notifier",
  version: "1.0.0",
  permissions: ["ui", "notify"],
  services: ["notify"],
};

export default function (ctx) {
  ctx.ui.render("main", "go", { type: "button", label: "Notify", action: "go" });
  ctx.ui.onEvent(async () => {
    const here = ctx.traced();
    const shown = await here.call("notify", "show", { title: "The writer is done", body: "Its edits are in the post.", tag: "agent", always: true }).catch((e) => e.message);
    here.log("shown " + shown);
  });
}
`;

export default async function ({ check, errors, URL }) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const context = await browser.newContext();
    await context.grantPermissions(["notifications"], { origin: new globalThis.URL(URL).origin });
    const openTab = async (url) => {
      const tab = await context.newPage();
      tab.on("pageerror", (e) => errors.push(`notify-service-worker: ${e.message}`));
      await tab.goto(url);
      await tab.waitForFunction(() => window.__host);
      return tab;
    };
    await run({ check, openTab, URL });
  } finally {
    await browser.close();
  }
}

async function run({ check, openTab, URL }) {
  const page = await openTab(URL);
  await page.evaluate(
    async ([html, plugin]) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of ["made", "apps", "notifier"]) dir = await dir.getDirectoryHandle(part, { create: true });
      for (const [name, body] of [["app.html", html], ["notifier.js", plugin]]) {
        const out = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await out.write(body);
        await out.close();
      }
    },
    [PAGE, PLUGIN],
  );

  // Only an address on this site is ever opened from a notification.
  const addresses = await page.evaluate(async () => {
    const { addressOf, appOf } = await import("/sw/notifications.js");
    return [
      addressOf({ data: { url: `${location.origin}/apps/notifier/` } }).pathname,
      addressOf({ data: { url: "https://elsewhere.example/phish" } }).href,
      addressOf({}).pathname,
      appOf({ data: { url: `${location.origin}/apps/notifier`, app: `${location.origin}/apps/notifier/` } }),
      appOf({ data: { app: "https://elsewhere.example/apps/x/" } }),
    ];
  });
  check("a click on a notification opens only an address on this site", addresses[0] === "/apps/notifier/" && addresses[1] === new globalThis.URL("/", URL).href && addresses[2] === "/" && addresses[3] === "/apps/notifier/" && addresses[4] === "/", JSON.stringify(addresses));

  await page.goto(`${URL}apps/notifier/`);
  const button = '[data-key="notify-sw:go"] button';
  const ready = await page.waitForSelector(button, { timeout: 15000 }).then(() => true, () => false);
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (ready) await page.click(button);
  const shown = await page
    .waitForFunction(() => window.__host.traces.find((e) => e.plugin === "notify-sw" && e.detail?.startsWith("shown "))?.detail, null, { timeout: 8000 })
    .then((h) => h.jsonValue(), () => "");
  // The page hands it to the service worker, which shows it a moment later.
  const kept = await page
    .waitForFunction(async () => {
      const shown = await (await navigator.serviceWorker.ready).getNotifications({ tag: "notify-sw:agent" });
      return shown.length ? shown.map((n) => ({ title: n.title, url: n.data?.url, app: n.data?.app })) : false;
    }, null, { timeout: 5000 })
    .then((h) => h.jsonValue(), () => []);
  check(
    "a plugin's notification is the service worker's, with the address it came from",
    shown === "shown true" && kept.length === 1 && kept[0].title === "The writer is done" && /\/apps\/notifier\/$/.test(kept[0].url ?? "") && /\/apps\/notifier\/$/.test(kept[0].app ?? ""),
    `${shown} ${JSON.stringify(kept)}`,
  );

  // Every tab of the app closed: the notification is still there to click.
  await page.close();
  const other = await openTab(URL);
  const after = await other.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications({ tag: "notify-sw:agent" })).length);
  check("the notification stays after the app's tab closes", after === 1, `${after} kept`);
  await other.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications({ tag: "notify-sw:agent" })).forEach((n) => n.close()));
  await other.close();
}
