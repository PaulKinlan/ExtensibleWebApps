// Content-addressed registry integrity, permission-diff package updates, and
// full local OPFS profile backup & restore (scripts/packages.mjs,
// src/kernel/authoring.ts, src/kernel/user-plugin-changes.ts,
// src/kernel/panel-commands.ts, std/customize.js, std/customize.html).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expected, integrityOf } from "../../scripts/packages.mjs";
import { watchErrors } from "../page-errors.mjs";

const SITE = new globalThis.URL("../../", import.meta.url);

async function waitUntil(page, fn, arg, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(fn, arg).catch(() => false);
    if (ok) return ok;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

export default async function ({ check, context, URL, errors }) {
  // 1. Registry index.json & catalog.json carry version and content-addressed sha256-<base64> integrity.
  const made = await expected();
  const index = JSON.parse(made["index.json"]);
  const catalog = JSON.parse(made["catalog.json"]);
  const sri = /^sha256-[A-Za-z0-9+/]{43}=$/;

  check(
    "every entry in packages/index.json and catalog.json has a sha256-<base64> integrity",
    index.packages.length > 0 &&
      catalog.plugins.length > 0 &&
      index.packages.every((p) => sri.test(p.integrity) && typeof p.version === "string" && p.version.length > 0) &&
      catalog.plugins.every((p) => sri.test(p.integrity)),
    `index=${index.packages.length}, catalog=${catalog.plugins.length}`,
  );

  const clockUrl = new globalThis.URL("packages/clock/clock.js", SITE);
  const clockSource = readFileSync(clockUrl, "utf8");
  const clockExpectedSri = `sha256-${createHash("sha256").update(Buffer.from(clockSource, "utf8")).digest("base64")}`;
  const clockEntry = index.packages.find((p) => p.id === "clock");
  check("single-file package integrity matches SHA-256 of its source", clockEntry?.integrity === clockExpectedSri, `${clockEntry?.integrity} vs ${clockExpectedSri}`);

  const worldUrl = new globalThis.URL("packages/world-clock/world-clock.js", SITE);
  const worldSource = readFileSync(worldUrl, "utf8");
  const worldEntry = index.packages.find((p) => p.id === "world-clock");
  const worldSingleOnly = integrityOf(worldUrl, worldSource, []);
  check(
    "multi-file package integrity hashes accompanying files as well as the main module",
    worldEntry?.integrity === integrityOf(worldUrl, worldSource, ["world-clock.html"]) && worldEntry?.integrity !== worldSingleOnly,
    worldEntry?.integrity,
  );

  // Isolated browser context with `?kernel=dedicated` so Playwright context.route intercepts kernel worker fetches cleanly.
  const own = await context.browser().newContext({ serviceWorkers: "block", acceptDownloads: true });
  try {
    let tamperClock = true;
    let updatedClockSource = null;

    await own.route(`${URL}packages/clock/clock.js`, async (route) => {
      if (tamperClock) {
        return route.fulfill({
          contentType: "text/javascript",
          body: `${clockSource}\n// tampered payload`,
        });
      }
      if (updatedClockSource) {
        return route.fulfill({
          contentType: "text/javascript",
          body: updatedClockSource,
        });
      }
      return route.continue();
    });

    await own.route(`${URL}packages/index.json`, async (route) => {
      if (!updatedClockSource) return route.continue();
      const updated = structuredClone(index);
      const target = updated.packages.find((p) => p.id === "clock");
      target.version = "1.1.0";
      target.permissions = ["provide:clock", "network:timeapi.io"];
      target.integrity = integrityOf(clockUrl, updatedClockSource, []);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(updated, null, 2),
      });
    });

    const app = "demos/habits";
    const page = await own.newPage();
    watchErrors(page, errors, "registry-backup");
    await page.goto(`${URL}${app}/app.html?kernel=dedicated`);
    await waitUntil(page, () => Boolean(window.__host));

    // 2. Tampered package response is refused before review or installation.
    const tamperedAdd = await page.evaluate((app) => window.__host.command("user:add", { app, url: "/packages/clock/clock.js" }), app);
    const listAfterTamper = await page.evaluate((app) => window.__host.command("user:list", { app }), app);
    check(
      "installing a registry package refuses a tampered response whose SHA-256 doesn't match index.json",
      tamperedAdd?.ok === false && /Integrity check failed/i.test(tamperedAdd.error ?? "") && !listAfterTamper.some((p) => p.id === "clock"),
      JSON.stringify(tamperedAdd),
    );

    // 3. Install valid clock v1.0.0 from Customize, then publish v1.1.0 requesting a new permission.
    tamperClock = false;
    await page.click("ui-panel .launch");
    await page.waitForSelector('[data-package="clock"]', { timeout: 8000 });
    await page.click('[data-package="clock"]');
    await page.waitForSelector('[data-key^="review:"] >> text=adds Clock', { timeout: 10000 });
    await page.click('[data-key^="review:"] >> text=Accept');
    await waitUntil(page, () => /^Added Clock/.test(document.querySelector("ui-panel [role=status]")?.textContent ?? ""));

    // Publish clock v1.1.0 with an added permission `network:timeapi.io`.
    updatedClockSource = clockSource
      .replace('version: "1.0.0"', 'version: "1.1.0"')
      .replace('permissions: ["provide:clock"]', 'permissions: ["provide:clock", "network:timeapi.io"]');

    // Close and reopen Customize so it fetches the updated registry index.
    await page.click("ui-panel .close");
    await page.click("ui-panel .launch");
    await page.waitForSelector('[data-update="clock"]', { timeout: 8000 });

    const badgeText = await page.textContent('[data-update-badge="clock"]');
    const badgeTone = await page.getAttribute('[data-update-badge="clock"]', "tone");
    check(
      "Customize surfaces an Update button and warn ui-badge when a registry update requests new permissions",
      badgeTone === "warn" && /1 new permission/.test(badgeText ?? ""),
      `${badgeTone}: ${badgeText}`,
    );

    // Also verify authoring.mine(), authoring.packages(), and authoring.backup() directly from a tab-scoped plugin.
    const PROBE = `export const manifest = { id: 'reg-backup-probe', name: 'Probe', scope: 'tab', permissions: ['plugins:read', 'plugins:author'] };
export default async (ctx) => {
  const mine = (await ctx.call('authoring', 'mine')).find((p) => p.id === 'clock');
  const pkg = (await ctx.call('authoring', 'packages')).find((p) => p.id === 'clock');
  const bkp = await ctx.call('authoring', 'backup');
  ctx.log('probe-state ' + JSON.stringify({ mine, pkg, bkpFormat: bkp.format, bkpHasSecret: 'secrets.json' in bkp.files }));
};`;
    await page.evaluate(([app, data]) => window.__host.command("user:add", { app, files: [{ name: "reg-backup-probe.js", data }] }), [app, PROBE]);
    await page.evaluate((app) => window.__host.command("user:on", { app, id: "reg-backup-probe" }), app);
    await waitUntil(page, () => window.__host.traces.some((e) => e.plugin?.startsWith("reg-backup-probe") && e.detail?.startsWith("probe-state ")));
    const probeState = await page.evaluate(() =>
      JSON.parse(window.__host.traces.find((e) => e.plugin?.startsWith("reg-backup-probe") && e.detail?.startsWith("probe-state ")).detail.slice("probe-state ".length)),
    );
    await page.evaluate((app) => window.__host.command("user:remove", { app, id: "reg-backup-probe" }), app);
    check(
      "authoring.mine() and authoring.packages() expose updateAvailable and addedPermissions, and authoring.backup() returns the archive",
      probeState.mine?.updateAvailable === true &&
        JSON.stringify(probeState.mine?.addedPermissions) === '["network:timeapi.io"]' &&
        probeState.pkg?.updateAvailable === true &&
        JSON.stringify(probeState.pkg?.addedPermissions) === '["network:timeapi.io"]' &&
        probeState.bkpFormat === "extensible-web-apps/backup" &&
        probeState.bkpHasSecret === false,
      JSON.stringify(probeState),
    );

    // Verify phone-width layout of Customize with the Update badge & Backup controls (no sideways scroll, control heights <= 64px).
    await page.setViewportSize({ width: 390, height: 844 });
    const phoneLayout = await page.evaluate(() => {
      const doc = document.documentElement;
      const buttons = [...document.querySelectorAll('[data-update="clock"], [data-backup], [data-restore]')];
      return {
        sideways: doc.scrollWidth > doc.clientWidth + 1,
        heights: buttons.map((b) => Math.round(b.getBoundingClientRect().height)),
      };
    });
    check(
      "Update and Backup controls fit at 390px phone width with no sideways scroll and standard control height",
      !phoneLayout.sideways && phoneLayout.heights.length === 3 && phoneLayout.heights.every((h) => h >= 28 && h <= 64),
      JSON.stringify(phoneLayout),
    );
    await page.setViewportSize({ width: 1280, height: 800 });

    // Click Update and verify the permission-diff review card highlights `network:timeapi.io`.
    await page.click('[data-update="clock"]');
    await page.waitForSelector('[data-key^="review:"] >> text=updates Clock', { timeout: 10000 });
    const reviewText = await page.textContent('[data-key^="review:"]');
    check(
      "authoring.update review card specifically highlights newly added permissions before updating",
      reviewText.includes("+1 new permission: network:timeapi.io") && reviewText.includes("New permissions requested: network:timeapi.io"),
      reviewText.slice(0, 220),
    );
    await page.click('[data-key^="review:"] >> text=Accept');
    await waitUntil(page, () => /^Updated Clock/.test(document.querySelector("ui-panel [role=status]")?.textContent ?? ""));

    const updatedMine = await page.evaluate((app) => window.__host.command("user:list", { app }), app);
    const updatedClock = updatedMine.find((p) => p.id === "clock");
    const updateBtnGone = (await page.locator('[data-update="clock"]').count()) === 0;
    check(
      "accepting the update installs the new version, preserves its enabled state, and clears the update badge",
      updatedClock?.on === true && updatedClock?.permissions?.includes("network:timeapi.io") && updateBtnGone,
      JSON.stringify(updatedClock),
    );

    // 4. Full local OPFS backup & restore round-trip (strictly excluding secrets.json and sync/).
    await page.click("ui-panel .close");
    const habitView = '[data-key="habits:habits"]';
    await page.fill(`${habitView} ui-form input[name=name]`, "Morning walk");
    await page.click(`${habitView} ui-form button[type=submit]`);
    await page.waitForSelector(`${habitView} >> text=Morning walk`, { timeout: 5000 });

    // Seed secrets.json and sync/signed-in.json directly into OPFS to verify they never leak in backups.
    const SECRET_CANARY = "sk-live-secret-never-export-999";
    await page.evaluate(async (canary) => {
      const root = await navigator.storage.getDirectory();
      const write = async (dir, name, text) => {
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
      };
      await write(root, "secrets.json", JSON.stringify({ openai: canary }));
      const syncDir = await root.getDirectoryHandle("sync", { create: true });
      await write(syncDir, "signed-in.json", JSON.stringify({ user: "alice" }));
    }, SECRET_CANARY);

    await page.click("ui-panel .launch");
    await page.waitForSelector("[data-backup]", { timeout: 5000 });

    // Export backup via Customize's download button AND inspect its JSON payload.
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("[data-backup]")]);
    const dlPath = await download.path();
    const exportedJson = readFileSync(dlPath, "utf8");
    const archive = JSON.parse(exportedJson);

    check(
      "local backup exports collections and user plugins while strictly excluding secrets.json and sync/ marks",
      archive.format === "extensible-web-apps/backup" &&
        archive.version === 1 &&
        Boolean(archive.files["collections/habits.json"]) &&
        Boolean(archive.files["user/demos/habits/clock.js"]) &&
        Boolean(archive.files["user-plugins.json"]) &&
        !("secrets.json" in archive.files) &&
        !Object.keys(archive.files).some((k) => k.startsWith("sync/")) &&
        !exportedJson.includes(SECRET_CANARY),
      Object.keys(archive.files).join(", "),
    );

    // Path validation on restore refuses traversal, secrets.json, and sync/ paths before review.
    const badTraversal = await page.evaluate(
      (base) => window.__host.command("user:restore", { archive: { ...base, files: { "../escape.js": { text: "evil" } } } }),
      archive,
    );
    const badSecrets = await page.evaluate(
      (base) => window.__host.command("user:restore", { archive: { ...base, files: { "secrets.json": { text: "{}" } } } }),
      archive,
    );
    const badSync = await page.evaluate(
      (base) => window.__host.command("user:restore", { archive: { ...base, files: { "sync/account.json": { text: "{}" } } } }),
      archive,
    );
    check(
      "restore validates every path with checkPath and refuses traversal, secrets.json, and sync/ paths",
      badTraversal?.ok === false && badSecrets?.ok === false && badSync?.ok === false,
      JSON.stringify({ badTraversal, badSecrets, badSync }),
    );

    // Delete the habit and remove the user plugin so the device no longer has them.
    await page.click("ui-panel .close");
    const deletePlugin = `export const manifest = { id: 'wipe-habits', name: 'Wipe', permissions: ['data:read:habits', 'data:write:habits'] };
export default async (ctx) => {
  for (const h of await ctx.call('data', 'list', 'habits')) await ctx.call('data', 'delete', 'habits', h.id, 'clear before restore');
  ctx.log('wiped-done');
};`;
    await page.evaluate((src) => window.__host.command("install", src), deletePlugin);
    await page.waitForSelector('[data-key^="review:"] >> text=delete a record', { timeout: 10000 });
    await page.click('[data-key^="review:"] >> text=Accept');
    await waitUntil(page, () => window.__host.traces.some((e) => e.plugin === "wipe-habits" && e.detail === "wiped-done"));
    await page.evaluate(() => window.__host.command("uninstall", "wipe-habits"));
    await page.evaluate((app) => window.__host.command("user:remove", { app, id: "clock" }), app);

    const clearedList = await page.evaluate((app) => window.__host.command("user:list", { app }), app);
    const habitGone = (await page.locator(`${habitView} >> text=Morning walk`).count()) === 0;
    check("device state is cleared before restore", habitGone && !clearedList.some((p) => p.id === "clock"), JSON.stringify(clearedList));

    // Restore backup via Customize's Restore backup button, accepting the single summary review card.
    await page.click("ui-panel .launch");
    await page.waitForSelector("[data-restore]", { timeout: 5000 });
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("[data-restore]")]);
    await chooser.setFiles({
      name: "backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(exportedJson, "utf8"),
    });

    await page.waitForSelector('[data-key^="review:"] >> text=restores backup', { timeout: 10000 });
    const restoreCardText = await page.textContent('[data-key^="review:"]');
    check(
      "restore shows a single review card summarizing collections and plugins before writing",
      restoreCardText.includes("1 collection") &&
        restoreCardText.includes("1 plugin") &&
        restoreCardText.includes("Habits") &&
        restoreCardText.includes("Clock"),
      restoreCardText.slice(0, 240),
    );
    await page.click('[data-key^="review:"] >> text=Accept');
    await waitUntil(page, () => /^Restored backup/.test(document.querySelector("ui-panel [role=status]")?.textContent ?? ""));
    await page.click("ui-panel .close");

    // Confirm both the collection record and the user plugin restored cleanly, and secrets.json was preserved untouched.
    const habitRestored = await page.waitForSelector(`${habitView} >> text=Morning walk`, { timeout: 8000 }).then(() => true, () => false);
    const restoredPlugins = await page.evaluate((app) => window.__host.command("user:list", { app }), app);
    const secretIntact = await page.evaluate(async (canary) => {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle("secrets.json");
      const text = await (await fh.getFile()).text();
      return text.includes(canary);
    }, SECRET_CANARY);

    check(
      "restoring a local backup brings back collections and user plugins while leaving device secrets untouched",
      habitRestored && restoredPlugins.some((p) => p.id === "clock" && p.on === true) && secretIntact,
      JSON.stringify({ habitRestored, restoredPlugins, secretIntact }),
    );
  } finally {
    await own.close();
  }
}
