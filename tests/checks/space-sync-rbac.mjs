// Field-level 3-way sync merge, space RBAC (`viewer` role + `x-ownership: "creator"`),
// and content-addressed blob sync (`sync.putBlob` / `sync.getBlob`) across members'
// devices in a space.
import { watchErrors } from "../page-errors.mjs";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../../src/server/serve.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const FORM = '[data-key="library:books"] ui-form';
const TABLE = '[data-key="library:books"] ui-table';

async function withAuthenticator(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

async function signUp(browser, address, name, errors) {
  const context = await browser.newContext();
  const page = await context.newPage();
  watchErrors(page, errors, `space-sync-rbac ${name}`);
  await withAuthenticator(context, page);
  await page.goto(address);
  await page.fill('form[data-action="register"] input[name="name"]', name);
  await page.click('form[data-action="register"] button[type="submit"]');
  await page.waitForSelector(".signed-in", { timeout: 8000 });
  return { context, page };
}

async function openList(page, base, space = "studio") {
  await page.goto(`${base}/s/${space}/demos/reading-list/`);
  await page.waitForSelector(FORM, { timeout: 15000 });
}

const hasTitle = (page, title, timeout = 15000) =>
  page.locator(`${TABLE} tbody tr`, { hasText: title }).first().waitFor({ timeout }).then(() => true, () => false);

const syncState = (page) => page.evaluate(() => window.__host.command("sync"));

async function waitSettled(page, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const s = await syncState(page).catch(() => null);
    if (s?.connected && s.pending === 0) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

/** Runs a one-shot helper plugin in `page` and returns the JSON object it logged with `prefix`. */
let helperSeq = 0;
async function runInPlugin(page, permissions, bodySource) {
  const id = `rbac-probe-${++helperSeq}`;
  const prefix = `probe:${id}:`;
  const source = `export const manifest = { id: '${id}', name: 'Probe ${id}', permissions: ${JSON.stringify(permissions)} };
export default async (ctx) => {
  try {
    const value = await (${bodySource})(ctx);
    ctx.log(${JSON.stringify(prefix)} + JSON.stringify({ ok: true, value }));
  } catch (error) {
    ctx.log(${JSON.stringify(prefix)} + JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
  }
};`;
  const installed = await page.evaluate((src) => window.__host.command("install", src), source);
  if (!installed?.ok) return { ok: false, error: installed?.error ?? "install failed" };
  try {
    const detail = await page
      .waitForFunction(([pid, pfx]) => window.__host.traces.findLast((e) => e.plugin?.startsWith(pid) && e.detail?.startsWith(pfx))?.detail, [id, prefix], { timeout: 15000 })
      .then((h) => h.jsonValue());
    return JSON.parse(String(detail).slice(prefix.length));
  } finally {
    await page.evaluate((pid) => window.__host.command("uninstall", pid), id).catch(() => {});
  }
}

/** Raw sync WebSocket client for testing protocol-level viewer refusals on plugins and apps. */
async function rawSyncClient(base, space, cookie) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/s/${space}/kernel`, { headers: { cookie } });
  const heard = [];
  ws.onmessage = (e) => {
    try {
      heard.push(JSON.parse(String(e.data)));
    } catch {}
  };
  await new Promise((open, fail) => {
    ws.onopen = open;
    ws.onerror = () => fail(new Error("WebSocket failed"));
  });
  ws.send(JSON.stringify({ t: "hello", tab: `raw-${Math.random().toString(36).slice(2, 8)}` }));
  ws.send(JSON.stringify({ t: "sync", op: "hello", since: 0 }));
  await new Promise((r) => setTimeout(r, 250));
  let reqId = 0;
  return {
    ask(op, payload) {
      const id = ++reqId;
      ws.send(JSON.stringify({ t: "sync", op, id, ...payload }));
      return new Promise((done) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          const reply = heard.find((m) => m.op === `${op}:reply` && m.id === id);
          if (reply || Date.now() > deadline) return done(reply);
          setTimeout(poll, 40);
        };
        poll();
      });
    },
    close: () => ws.close(),
  };
}

/** Verifies `x-ownership: "creator"` enforcement in `syncHub` directly with an in-memory store and registry. */
async function checkCreatorOwnership(check) {
  const bundled = await build({
    stdin: { contents: 'export { syncHub } from "./std/spaces/hub.ts";', resolveDir: ROOT, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  const { syncHub } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  const files = new Map();
  const store = {
    readJson: async (name, fallback) => (files.has(name) ? JSON.parse(files.get(name)) : fallback),
    writeJson: async (name, val) => void files.set(name, JSON.stringify(val)),
  };
  const data = new Map();
  const registry = new Map([
    [
      "notes",
      {
        name: "notes",
        owner: "notes-plugin",
        title: "Notes",
        schema: { type: "object", "x-ownership": "creator", properties: { text: { type: "string" } }, required: ["text"] },
      },
    ],
  ]);
  const records = {
    registry,
    written: new Set(),
    record: async (_col, id) => data.get(id) ?? null,
    apply: async (_col, id, after) => {
      if (after) data.set(id, after);
      else data.delete(id);
      return { collection: "notes", id, after: after ?? undefined };
    },
  };
  const sent = new Map();
  const hosts = {
    mode: "server",
    list: [],
    send: (host, msg) => {
      const list = sent.get(host) ?? [];
      list.push(msg);
      sent.set(host, list);
    },
  };
  const root = { serial: async () => undefined };
  const hub = syncHub(root, store, records, hosts);
  const hostAnn = { tab: "t-ann", member: "u-ann", port: {} };
  const hostBen = { tab: "t-ben", member: "u-ben", port: {} };

  const pushAs = async (host, changes) => {
    const id = Math.floor(Math.random() * 1e6);
    await hub.handle(host, { t: "sync", op: "push", id, changes });
    return (sent.get(host) ?? []).findLast((m) => m.op === "pushed" && m.id === id)?.results;
  };

  const created = await pushAs(hostBen, [{ collection: "notes", id: "n1", base: 0, after: { id: "n1", text: "Ben's note" } }]);
  const stored = data.get("n1");
  const hijackEdit = await pushAs(hostAnn, [{ collection: "notes", id: "n1", base: 1, after: { id: "n1", text: "Taken by peer" } }]);
  const hijackDelete = await pushAs(hostAnn, [{ collection: "notes", id: "n1", base: 1, after: null }]);
  const ownEdit = await pushAs(hostBen, [{ collection: "notes", id: "n1", base: 1, after: { id: "n1", text: "Updated by Ben" } }]);
  await hub.stop();

  check(
    "space RBAC: x-ownership 'creator' stamps createdBy on new records, lets the creator update, and refuses updates or deletes from other non-owner members",
    created?.[0]?.ok === true &&
      stored?.createdBy === "u-ben" &&
      hijackEdit?.[0]?.ok === false &&
      /created this record/.test(hijackEdit[0].error ?? "") &&
      hijackDelete?.[0]?.ok === false &&
      ownEdit?.[0]?.ok === true &&
      data.get("n1")?.text === "Updated by Ben" &&
      data.get("n1")?.createdBy === "u-ben",
    JSON.stringify({ created, stored, hijackEdit, hijackDelete, ownEdit }),
  );
}

export default async function ({ check, context, errors }) {
  await checkCreatorOwnership(check);

  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "space-sync-rbac-"));
  const options = { port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" };
  let server = await serve(options);
  const port = Number(new URL(server.url).port);
  const devices = [];

  try {
    // 1. Ann creates `studio` and invites Ben as a normal member.
    const ann = await signUp(browser, `${server.url}/account/`, "Ann", errors);
    devices.push(ann.context);
    await ann.page.fill('form[data-action="make"] input[name="name"]', "studio");
    await ann.page.click('form[data-action="make"] button[type="submit"]');
    await ann.page.waitForSelector('.space-list button:has-text("Invite someone")', { timeout: 8000 });
    await ann.page.click('.space-list button:has-text("Invite someone")');
    await ann.page.waitForSelector(".invite input", { timeout: 8000 });
    const memberInvite = await ann.page.inputValue(".invite input");
    const ben = await signUp(browser, memberInvite, "Ben", errors);
    devices.push(ben.context);

    // Ann also invites Cam as a read-only `viewer` using the role selector on /account/.
    await ann.page.goto(`${server.url}/account/`);
    await ann.page.waitForSelector('form[data-action="invite:studio"] select[name="role"]', { timeout: 8000 });
    await ann.page.selectOption('form[data-action="invite:studio"] select[name="role"]', "viewer");
    await ann.page.click('.space-list button:has-text("Invite someone")');
    await ann.page.waitForFunction(() => /viewer invite/.test(document.querySelector(".spaces .status")?.textContent ?? ""), null, { timeout: 8000 });
    const viewerInvite = await ann.page.inputValue(".invite input");
    const cam = await signUp(browser, viewerInvite, "Cam", errors);
    devices.push(cam.context);
    await cam.page.waitForSelector(".space-list strong", { timeout: 8000 });
    const camSpacesText = (await cam.page.locator(".space-list").textContent()) ?? "";
    await ann.page.reload();
    await ann.page.waitForSelector(".member-list", { timeout: 8000 });
    const annMembersText = (await ann.page.locator(".member-list").first().textContent()) ?? "";
    check(
      "space RBAC: an owner can invite someone as a viewer on /account/, and both see the viewer role",
      /studio \(viewer\)/.test(camSpacesText) && /Cam \(viewer\)/.test(annMembersText) && /Ben \(member\)/.test(annMembersText),
      JSON.stringify({ camSpacesText, annMembersText }),
    );

    // 2. Open reading-list in `studio` on Ann, Ben, and Cam.
    await openList(ann.page, server.url);
    await openList(ben.page, server.url);
    await openList(cam.page, server.url);
    await waitSettled(ann.page);
    await waitSettled(ben.page);
    await waitSettled(cam.page);

    // Ann adds a shared book via the reading-list form.
    await ann.page.fill(`${FORM} input[name="title"]`, "Hyperion");
    await ann.page.fill(`${FORM} input[name="author"]`, "Simmons");
    await ann.page.click(`${FORM} button[type="submit"]`);
    const reachedBen = await hasTitle(ben.page, "Hyperion", 15000);
    const reachedCam = await hasTitle(cam.page, "Hyperion", 15000);
    await waitSettled(ann.page);
    await waitSettled(ben.page);
    await waitSettled(cam.page);
    check("space RBAC: a viewer joins the space and receives synced records", reachedBen && reachedCam);

    // 3. Field-level 3-way auto-merge: take server offline; Ann edits `author`, Ben edits `notes` on Hyperion!
    await server.stop();

    // Edit `author` on Ann's device via form: click row -> change author -> Save changes.
    await ann.page.locator(`${TABLE} tbody tr`, { hasText: "Hyperion" }).first().locator("button").first().click();
    await ann.page.waitForSelector(`${FORM} button:has-text("Save changes")`, { timeout: 8000 });
    await ann.page.fill(`${FORM} input[name="author"]`, "Dan Simmons");
    await ann.page.click(`${FORM} button:has-text("Save changes")`);
    await ann.page.waitForSelector(`${FORM} button:has-text("Save changes")`, { state: "detached", timeout: 5000 });

    // Edit `notes` on Ben's device via form: click row -> change notes -> Save changes.
    await ben.page.locator(`${TABLE} tbody tr`, { hasText: "Hyperion" }).first().locator("button").first().click();
    await ben.page.waitForSelector(`${FORM} button:has-text("Save changes")`, { timeout: 8000 });
    await ben.page.fill(`${FORM} textarea[name="notes"]`, "Hugo winner");
    await ben.page.click(`${FORM} button:has-text("Save changes")`);
    await ben.page.waitForSelector(`${FORM} button:has-text("Save changes")`, { state: "detached", timeout: 5000 });

    // Bring server back and wait for both devices to sync and auto-merge.
    server = await serve({ ...options, port });
    await waitSettled(ann.page);
    await waitSettled(ben.page);
    await ann.page.waitForTimeout(800);

    const readHyperion = (page) =>
      runInPlugin(
        page,
        ["data:read:library"],
        `async (ctx) => (await ctx.call("data", "list", "library")).find((b) => b.title === "Hyperion")`,
      );
    const [annMerged, benMerged] = await Promise.all([readHyperion(ann.page), readHyperion(ben.page)]);
    const mergeDrafts = [...(await syncState(ann.page)).drafts, ...(await syncState(ben.page)).drafts];
    check(
      "field-level 3-way merge: concurrent offline edits to disjoint fields (author vs notes) auto-merge cleanly on both devices with zero conflict drafts",
      annMerged.ok &&
        benMerged.ok &&
        annMerged.value?.author === "Dan Simmons" &&
        annMerged.value?.notes === "Hugo winner" &&
        benMerged.value?.author === "Dan Simmons" &&
        benMerged.value?.notes === "Hugo winner" &&
        mergeDrafts.length === 0,
      JSON.stringify({ annMerged, benMerged, mergeDrafts }),
    );

    // 4. Same-field concurrent edits still refuse as stale and keep a conflict draft.
    await server.stop();
    await ann.page.locator(`${TABLE} tbody tr`, { hasText: "Hyperion" }).first().locator("button").first().click();
    await ann.page.waitForSelector(`${FORM} button:has-text("Save changes")`, { timeout: 8000 });
    await ann.page.fill(`${FORM} input[name="title"]`, "Hyperion Cantos (Ann)");
    await ann.page.click(`${FORM} button:has-text("Save changes")`);
    await hasTitle(ann.page, "Hyperion Cantos (Ann)", 5000);

    await ben.page.locator(`${TABLE} tbody tr`, { hasText: "Hyperion" }).first().locator("button").first().click();
    await ben.page.waitForSelector(`${FORM} button:has-text("Save changes")`, { timeout: 8000 });
    await ben.page.fill(`${FORM} input[name="title"]`, "Hyperion Cantos (Ben)");
    await ben.page.click(`${FORM} button:has-text("Save changes")`);
    await hasTitle(ben.page, "Hyperion Cantos (Ben)", 5000);

    server = await serve({ ...options, port });
    await waitSettled(ann.page);
    await waitSettled(ben.page);
    await ann.page.waitForTimeout(800);

    const conflictDrafts = [...(await syncState(ann.page)).drafts, ...(await syncState(ben.page)).drafts];
    check(
      "field-level 3-way merge: concurrent edits to the same field still refuse as stale and preserve the losing edit as a draft",
      conflictDrafts.length === 1 && /Hyperion Cantos \((Ann|Ben)\)/.test(conflictDrafts[0]?.mine?.title ?? ""),
      JSON.stringify(conflictDrafts),
    );

    // 5. Viewer write refusal: Cam (viewer) tries to add a book, share a plugin, and share an app.
    await waitSettled(cam.page);
    await cam.page.fill(`${FORM} input[name="title"]`, "Viewer Attempt");
    await cam.page.click(`${FORM} button[type="submit"]`);
    const draftDeadline = Date.now() + 10000;
    while (Date.now() < draftDeadline) {
      const s = await syncState(cam.page).catch(() => null);
      if (s?.drafts?.some((d) => d.mine?.title === "Viewer Attempt")) break;
      await cam.page.waitForTimeout(200);
    }
    const camSync = await syncState(cam.page);
    const viewerDraft = camSync.drafts.find((d) => d.mine?.title === "Viewer Attempt");
    const leakedToAnn = await hasTitle(ann.page, "Viewer Attempt", 1000);
    // Check raw plugin/app share refusals for viewer cookie as well.
    const camCookies = await cam.context.cookies(server.url);
    const camCookieHeader = camCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const rawCam = await rawSyncClient(server.url, "studio", camCookieHeader);
    const pluginListReply = await rawCam.ask("plugins", { action: "list" });
    const pluginAddReply = await rawCam.ask("plugins", {
      action: "add",
      app: "demos/reading-list",
      files: [{ name: "v.js", text: 'export const manifest = { id: "v", name: "V", permissions: [] };\nexport default () => {};' }],
    });
    const appShareReply = await rawCam.ask("apps", { action: "share", name: "vapp", files: [{ name: "app.html", text: "<!doctype html>" }] });
    rawCam.close();

    check(
      "space RBAC: a viewer's record push, plugin add, and app share are refused with 'Viewers can read this space, not change it'",
      !leakedToAnn &&
        viewerDraft?.why === "Viewers can read this space, not change it" &&
        pluginListReply?.ok === true &&
        pluginAddReply?.ok === false &&
        pluginAddReply?.error === "Viewers can read this space, not change it" &&
        appShareReply?.ok === false &&
        appShareReply?.error === "Viewers can read this space, not change it",
      JSON.stringify({ viewerDraft, pluginListReply, pluginAddReply, appShareReply }),
    );

    // 6. Content-addressed blob sync (`sync.putBlob` / `sync.getBlob`) across Ann, Ben, and Cam (including multi-chunk >512 KB blob).
    const putResult = await runInPlugin(
      ann.page,
      ["sync"],
      `async (ctx) => {
        const small = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 42, 99]);
        const large = new Uint8Array(600 * 1024);
        for (let i = 0; i < large.length; i++) large[i] = (i * 31 + 7) & 255;
        const a = await ctx.call("sync", "putBlob", small, "image/png");
        const b = await ctx.call("sync", "putBlob", large, "application/octet-stream");
        return { a, b };
      }`,
    );
    const smallHash = putResult.value?.a?.hash ?? "";
    const largeHash = putResult.value?.b?.hash ?? "";

    const getOnBen = await runInPlugin(
      ben.page,
      ["files:media"],
      `async (ctx) => {
        const gotSmall = await ctx.call("sync", "getBlob", ${JSON.stringify(smallHash)});
        const gotLarge = await ctx.call("sync", "getBlob", ${JSON.stringify(largeHash)});
        const missing = await ctx.call("sync", "getBlob", "0".repeat(64));
        let largeMatches = gotLarge?.data instanceof Uint8Array && gotLarge.data.byteLength === 600 * 1024;
        if (largeMatches) {
          for (let i = 0; i < gotLarge.data.length; i += 4093) {
            if (gotLarge.data[i] !== ((i * 31 + 7) & 255)) { largeMatches = false; break; }
          }
        }
        return {
          smallBytes: gotSmall?.data ? Array.from(gotSmall.data) : null,
          smallType: gotSmall?.mediaType,
          largeSize: gotLarge?.data?.byteLength,
          largeMatches,
          missing,
        };
      }`,
    );

    const viewerBlobCheck = await runInPlugin(
      cam.page,
      ["sync"],
      `async (ctx) => {
        const read = await ctx.call("sync", "getBlob", ${JSON.stringify(smallHash)});
        let writeError = "";
        try {
          await ctx.call("sync", "putBlob", new Uint8Array([1, 2, 3]), "application/octet-stream");
        } catch (err) {
          writeError = String(err?.message ?? err);
        }
        return { readSize: read?.data?.byteLength, mediaType: read?.mediaType, writeError };
      }`,
    );

    const deniedBlobCheck = await runInPlugin(ann.page, [], `async (ctx) => ctx.call("sync", "getBlob", ${JSON.stringify(smallHash)})`);

    check(
      "blob sync: sync.putBlob and sync.getBlob sync small and multi-chunk binary blobs across devices with SHA-256 verification, allow viewers to read but not write, and enforce permissions",
      putResult.ok &&
        /^[0-9a-f]{64}$/.test(smallHash) &&
        putResult.value.a.size === 12 &&
        putResult.value.b.size === 600 * 1024 &&
        getOnBen.ok &&
        JSON.stringify(getOnBen.value.smallBytes) === JSON.stringify([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 42, 99]) &&
        getOnBen.value.smallType === "image/png" &&
        getOnBen.value.largeMatches === true &&
        getOnBen.value.missing === null &&
        viewerBlobCheck.ok &&
        viewerBlobCheck.value.readSize === 12 &&
        viewerBlobCheck.value.writeError === "Viewers can read this space, not change it" &&
        deniedBlobCheck.ok === false &&
        /Missing capability/.test(deniedBlobCheck.error ?? ""),
      JSON.stringify({ putResult, getOnBen, viewerBlobCheck, deniedBlobCheck }),
    );

    // 7. Role switching (`/auth/spaces/<name>/role`) & MCP agent-key RBAC:
    //    viewers cannot mint agent keys; non-owners get 403 on role switch; promoting viewer -> member enables writes & keys; demoting revokes keys.
    const viewerKeyAttempt = await fetch(`${server.url}/auth/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url, cookie: camCookieHeader },
      body: JSON.stringify({ space: "studio", name: "Viewer MCP" }),
    });
    const benCookies = await ben.context.cookies(server.url);
    const benCookieHeader = benCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const camMe = await fetch(`${server.url}/auth/me`, { headers: { cookie: camCookieHeader } }).then((r) => r.json());
    const camId = camMe?.user?.id;
    const benTriesRole = await fetch(`${server.url}/auth/spaces/studio/role`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url, cookie: benCookieHeader },
      body: JSON.stringify({ user: camId, role: "member" }),
    });
    const annCookies = await ann.context.cookies(server.url);
    const annCookieHeader = annCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const annPromotesCam = await fetch(`${server.url}/auth/spaces/studio/role`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url, cookie: annCookieHeader },
      body: JSON.stringify({ user: camId, role: "member" }),
    });
    // Now Cam (promoted to member) can mint an agent key and push changes!
    const memberKeyMint = await fetch(`${server.url}/auth/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url, cookie: camCookieHeader },
      body: JSON.stringify({ space: "studio", name: "Member MCP" }),
    });
    await cam.page.fill(`${FORM} input[name="title"]`, "Cam Is Member Now");
    await cam.page.click(`${FORM} button[type="submit"]`);
    const camBookReachedAnn = await hasTitle(ann.page, "Cam Is Member Now", 15000);
    // Demoting Cam back to viewer revokes Cam's space agent keys.
    const annDemotesCam = await fetch(`${server.url}/auth/spaces/studio/role`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url, cookie: annCookieHeader },
      body: JSON.stringify({ user: camId, role: "viewer" }),
    });
    const camKeysAfterDemote = await fetch(`${server.url}/auth/keys`, { headers: { cookie: camCookieHeader } }).then((r) => r.json());
    check(
      "space RBAC: viewers cannot mint MCP keys, only owners switch roles via /auth/spaces/<name>/role, promoting enables writes, and demoting back to viewer revokes space keys",
      viewerKeyAttempt.status === 403 &&
        benTriesRole.status === 403 &&
        annPromotesCam.status === 200 &&
        memberKeyMint.status === 200 &&
        camBookReachedAnn &&
        annDemotesCam.status === 200 &&
        (camKeysAfterDemote?.keys ?? []).length === 0,
      JSON.stringify({
        viewerKeyStatus: viewerKeyAttempt.status,
        benStatus: benTriesRole.status,
        annStatus: annPromotesCam.status,
        memberKeyStatus: memberKeyMint.status,
        camBookReachedAnn,
        keysLeft: camKeysAfterDemote?.keys?.length,
      }),
    );
  } finally {
    for (const d of devices) await d.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true });
  }
}
