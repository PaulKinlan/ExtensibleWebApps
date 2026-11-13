// Field-level 3-way sync merge, space RBAC (`owner` / `editor` / `reader` + collection `rules`),
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

async function waitRole(page, expected, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const s = await syncState(page).catch(() => null);
    if (s?.access?.role === expected) return true;
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

/** Raw sync WebSocket client for testing protocol-level reader refusals on records, plugins, apps, and blobs. */
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
    ask(op, payload, replyOp = `${op}:reply`) {
      const id = ++reqId;
      ws.send(JSON.stringify({ t: "sync", op, id, ...payload }));
      return new Promise((done) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          const reply = heard.find((m) => m.op === replyOp && m.id === id);
          if (reply || Date.now() > deadline) return done(reply);
          setTimeout(poll, 40);
        };
        poll();
      });
    },
    close: () => ws.close(),
  };
}

/** Verifies collection `rules` (`author`) + `spacePermissions` enforcement in `syncHub` directly with an in-memory store. */
async function checkAuthorRulesInHub(check) {
  const bundled = await build({
    stdin: {
      contents: 'export { syncHub } from "./std/spaces/hub.ts"; export { spacePermissions } from "./std/spaces/permissions.ts";',
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  const { syncHub, spacePermissions } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
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
        schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
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
  const members = async () => [
    { id: "u-owner", name: "Owner", role: "owner" },
    { id: "u-ann", name: "Ann", role: "editor" },
    { id: "u-ben", name: "Ben", role: "editor" },
  ];
  const permit = spacePermissions(store, hosts, members, (name) => registry.get(name));
  permit.learn({
    id: "notes-plugin",
    name: "Notes",
    permissions: [],
    collections: {
      notes: {
        title: "Notes",
        schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        rules: { change: "author", remove: "author" },
      },
    },
  });
  await permit.settled();

  const root = { serial: async () => undefined };
  const hub = syncHub(root, store, records, hosts);
  hub.permit = permit;
  const hostAnn = { tab: "t-ann", member: "u-ann", port: {} };
  const hostBen = { tab: "t-ben", member: "u-ben", port: {} };

  const pushAs = async (host, role, changes) => {
    const id = Math.floor(Math.random() * 1e6);
    await hub.handle(host, { t: "sync", op: "push", id, role, changes });
    return (sent.get(host) ?? []).findLast((m) => m.op === "pushed" && m.id === id)?.results;
  };

  const created = await pushAs(hostBen, "editor", [{ collection: "notes", id: "n1", base: 0, after: { id: "n1", text: "Ben's note" } }]);
  const hijackEdit = await pushAs(hostAnn, "editor", [{ collection: "notes", id: "n1", base: 1, after: { id: "n1", text: "Taken by peer" } }]);
  const hijackDelete = await pushAs(hostAnn, "editor", [{ collection: "notes", id: "n1", base: 1, after: null }]);
  const ownEdit = await pushAs(hostBen, "editor", [{ collection: "notes", id: "n1", base: 1, after: { id: "n1", text: "Updated by Ben" } }]);
  await hub.stop();

  check(
    "space RBAC: collection rules { change: 'author', remove: 'author' } track record authors, let the author update, and refuse updates or deletes from other editors",
    created?.[0]?.ok === true &&
      hijackEdit?.[0]?.ok === false &&
      hijackEdit?.[0]?.denied === true &&
      /Ben added this/.test(hijackEdit[0].error ?? "") &&
      hijackDelete?.[0]?.ok === false &&
      ownEdit?.[0]?.ok === true &&
      data.get("n1")?.text === "Updated by Ben",
    JSON.stringify({ created, hijackEdit, hijackDelete, ownEdit }),
  );
}

/**
 * Deterministic regression check for #4556299334: when an in-flight push is 3-way merged by the server while
 * a newer local edit (and a write arriving during async `records.apply`) happened on the device, local `data.get`
 * and the server both retain the peer's merged fields AND all newer local edits once the queue drains.
 */
async function checkInFlightMergeLocalReconcile(check) {
  const bundled = await build({
    stdin: {
      contents: `
        export { Context } from "cordis";
        export { Store } from "./src/kernel/store.ts";
        export { Hosts } from "./src/kernel/hosts.ts";
        export { RemotePlugins } from "./src/kernel/remote.ts";
        export { collections } from "./src/kernel/records.ts";
        export { memoryFiles } from "./src/seams/memory.ts";
        export { syncHub } from "./std/spaces/hub.ts";
        export { syncDevice } from "./std/spaces/device.ts";
      `,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    logLevel: "silent",
  });
  const { Context, Store, Hosts, RemotePlugins, collections, memoryFiles, syncHub, syncDevice } = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );

  const manifest = {
    id: "books-owner",
    name: "Books",
    permissions: [],
    collections: {
      books: {
        title: "Books",
        schema: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string" },
            author: { type: "string" },
            notes: { type: "string" },
            genre: { type: "string" },
            rating: { type: "integer" },
          },
        },
      },
    },
  };

  // Space hub setup
  const hubRoot = new Context();
  const hubStore = new Store(hubRoot);
  hubStore.use(memoryFiles());
  let deliverToAnn = () => {};
  const hubHosts = {
    mode: "server",
    list: [],
    send: (host, msg) => {
      if (host.deliver) host.deliver(msg);
    },
  };
  const hubRemote = new RemotePlugins(hubRoot, hubHosts, {});
  const hubCols = collections(hubRoot, hubStore, hubHosts, hubRemote, async () => "allowed-once");
  await hubCols.ready;
  hubRemote.installed.set("books-owner", { id: "books-owner", source: "", manifest, caps: new Set(), origin: "app", enabled: true });
  hubCols.register(manifest);
  const hub = syncHub(hubRoot, hubStore, hubCols, hubHosts);

  const hostAnn = { tab: "t-ann", member: "u-ann", port: {}, deliver: (msg) => deliverToAnn(msg) };
  const hostBen = { tab: "t-ben", member: "u-ben", port: {} };

  // Controllable WebSocket wire between Ann's syncDevice and syncHub
  let holdWire = false;
  const heldClientToServer = [];
  const heldServerToClient = [];
  let activeSocket = null;

  const forwardToHub = async (raw) => {
    const parsed = JSON.parse(String(raw));
    if (parsed?.t === "sync") await hub.handle(hostAnn, { ...parsed, member: "u-ann", role: "editor" });
  };

  deliverToAnn = (msg) => {
    const raw = JSON.stringify(msg);
    if (holdWire) heldServerToClient.push(raw);
    else activeSocket?.onmessage?.({ data: raw });
  };

  class FakeSocket {
    readyState = 0;
    onopen = null;
    onmessage = null;
    onclose = null;
    constructor() {
      activeSocket = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(raw) {
      if (holdWire) heldClientToServer.push(raw);
      else void forwardToHub(raw);
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  const flushWire = async () => {
    holdWire = false;
    while (heldClientToServer.length || heldServerToClient.length) {
      while (heldClientToServer.length) await forwardToHub(heldClientToServer.shift());
      while (heldServerToClient.length) activeSocket?.onmessage?.({ data: heldServerToClient.shift() });
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  // Ann's device kernel setup
  const devRoot = new Context();
  const devStore = new Store(devRoot);
  devStore.use(memoryFiles());
  const devHosts = new Hosts();
  const devRemote = new RemotePlugins(devRoot, devHosts, {});
  const devCols = collections(devRoot, devStore, devHosts, devRemote, async () => "allowed-once");
  await devCols.ready;
  devRemote.installed.set("books-owner", { id: "books-owner", source: "", manifest, caps: new Set(), origin: "app", enabled: true });
  devCols.register(manifest);

  const device = syncDevice("ws://space.local/s/studio/kernel", devStore, devCols, devHosts, { WebSocketImpl: FakeSocket });
  const waitDeviceSettled = async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const s = await device.state();
      if (s.connected && s.pending === 0 && heldClientToServer.length === 0 && heldServerToClient.length === 0) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("Timed out waiting for syncDevice to settle");
  };

  const dataPut = (record) => devCols.service.call("books-owner", "put", ["books", record], {});
  const dataGet = (id) => devCols.service.call("books-owner", "get", ["books", id], {});

  try {
    await waitDeviceSettled();

    // Seed initial record b1 at seq = 1 from Ben and wait for Ann to receive it.
    await hub.handle(hostBen, {
      t: "sync",
      op: "push",
      id: 100,
      member: "u-ben",
      role: "editor",
      changes: [{ collection: "books", id: "b1", base: 0, after: { id: "b1", title: "Hyperion", author: "Simmons", notes: "First edition" } }],
    });
    await new Promise((r) => setTimeout(r, 20));
    await waitDeviceSettled();

    // 1. Hold wire so Ann's first push stays in flight while Ben updates `notes` on the server and Ann makes a 2nd local edit (`genre`).
    holdWire = true;
    await hub.handle(hostBen, {
      t: "sync",
      op: "push",
      id: 101,
      member: "u-ben",
      role: "editor",
      changes: [{ collection: "books", id: "b1", base: 1, after: { id: "b1", title: "Hyperion", author: "Simmons", notes: "Hugo winner" } }],
    });

    // Ann's 1st local edit (`author`) triggers an in-flight push (held in heldClientToServer).
    await dataPut({ id: "b1", title: "Hyperion", author: "Dan Simmons", notes: "First edition" });
    await new Promise((r) => setTimeout(r, 10));
    const pushInFlight = heldClientToServer.length === 1;

    // While that push is in flight, Ann makes a 2nd local edit (`genre: "sci-fi"`).
    await dataPut({ id: "b1", title: "Hyperion", author: "Dan Simmons", notes: "First edition", genre: "sci-fi" });

    // Release wire and wait for queue to drain completely.
    await flushWire();
    const state1 = await waitDeviceSettled();
    const localAfter1 = await dataGet("b1");
    const hubAfter1 = await hubCols.record("books", "b1");

    // 2. Also verify a 3rd local edit arriving mid-`records.apply` await during merge reconciliation is preserved!
    holdWire = true;
    const baseSeq2 = state1.seq;
    await hub.handle(hostBen, {
      t: "sync",
      op: "push",
      id: 102,
      member: "u-ben",
      role: "editor",
      changes: [
        {
          collection: "books",
          id: "b1",
          base: baseSeq2,
          after: { id: "b1", title: "Hyperion", author: "Dan Simmons", notes: "Hugo & Locus winner", genre: "sci-fi" },
        },
      ],
    });
    await dataPut({ id: "b1", title: "Hyperion", author: "Dan Simmons (rev 2)", notes: "Hugo winner", genre: "sci-fi" });
    await new Promise((r) => setTimeout(r, 10));
    await dataPut({ id: "b1", title: "Hyperion", author: "Dan Simmons (rev 2)", notes: "Hugo winner", genre: "space-opera" });

    const origApply = devCols.apply;
    let injectedMidApply = false;
    devCols.apply = async (...args) => {
      if (!injectedMidApply && String(args[3]?.trace ?? "").startsWith("sync-merged-")) {
        injectedMidApply = true;
        // Simulate a local edit landing while `reconcileMerged` is awaiting `records.apply` (before `origApply` updates local records).
        await dataPut({ id: "b1", title: "Hyperion", author: "Dan Simmons (rev 2)", notes: "Hugo winner", genre: "space-opera", rating: 5 });
      }
      return origApply(...args);
    };

    await flushWire();
    const state2 = await waitDeviceSettled();
    devCols.apply = origApply;
    const localAfter2 = await dataGet("b1");
    const hubAfter2 = await hubCols.record("books", "b1");

    check(
      "field-level 3-way merge: concurrent local edits during an in-flight auto-merged push (and during async records.apply) reconcile server-merged fields into local data.get",
      pushInFlight &&
        state1.drafts.length === 0 &&
        localAfter1?.author === "Dan Simmons" &&
        localAfter1?.notes === "Hugo winner" &&
        localAfter1?.genre === "sci-fi" &&
        hubAfter1?.author === "Dan Simmons" &&
        hubAfter1?.notes === "Hugo winner" &&
        hubAfter1?.genre === "sci-fi" &&
        injectedMidApply &&
        state2.drafts.length === 0 &&
        localAfter2?.author === "Dan Simmons (rev 2)" &&
        localAfter2?.notes === "Hugo & Locus winner" &&
        localAfter2?.genre === "space-opera" &&
        localAfter2?.rating === 5 &&
        hubAfter2?.author === "Dan Simmons (rev 2)" &&
        hubAfter2?.notes === "Hugo & Locus winner" &&
        hubAfter2?.genre === "space-opera" &&
        hubAfter2?.rating === 5,
      JSON.stringify({ pushInFlight, localAfter1, hubAfter1, injectedMidApply, localAfter2, hubAfter2 }),
    );
  } finally {
    device.stop();
    await hub.stop();
  }
}

export default async function ({ check, context, errors }) {
  await checkAuthorRulesInHub(check);
  await checkInFlightMergeLocalReconcile(check);

  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "space-sync-rbac-"));
  const options = { port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" };
  let server = await serve(options);
  const port = Number(new URL(server.url).port);
  const devices = [];

  try {
    // 1. Ann creates `studio` and invites Ben as an editor ("Invite someone").
    const ann = await signUp(browser, `${server.url}/account/`, "Ann", errors);
    devices.push(ann.context);
    await ann.page.fill('form[data-action="make"] input[name="name"]', "studio");
    await ann.page.click('form[data-action="make"] button[type="submit"]');
    await ann.page.waitForSelector('.space-list button:has-text("Invite someone")', { timeout: 8000 });
    await ann.page.click('.space-list button:has-text("Invite someone")');
    await ann.page.waitForSelector(".invite input", { timeout: 8000 });
    const editorInvite = await ann.page.inputValue(".invite input");
    const ben = await signUp(browser, editorInvite, "Ben", errors);
    devices.push(ben.context);

    // Ann also invites Cam as a read-only `reader` ("Invite a reader") on /account/.
    await ann.page.goto(`${server.url}/account/`);
    await ann.page.waitForSelector('.space-list button:has-text("Invite a reader")', { timeout: 8000 });
    await ann.page.click('.space-list button:has-text("Invite a reader")');
    await ann.page.waitForFunction(() => /not change it/.test(document.querySelector(".invite")?.textContent ?? ""), null, { timeout: 8000 });
    const readerInvite = await ann.page.inputValue(".invite input");
    const cam = await signUp(browser, readerInvite, "Cam", errors);
    devices.push(cam.context);
    await cam.page.waitForSelector(".space-list strong", { timeout: 8000 });
    const camSpacesText = ((await cam.page.locator(".space-list").textContent()) ?? "").replace(/\s+/g, " ").trim();
    await ann.page.reload();
    await ann.page.waitForSelector(".members", { timeout: 8000 });
    const annMembersText = ((await ann.page.locator(".members").first().textContent()) ?? "").replace(/\s+/g, " ").trim();
    check(
      "space RBAC: an owner can invite editors and readers on /account/, and both see their roles",
      /studio \(reader\)/.test(camSpacesText) && /Cam\s*Reader/.test(annMembersText) && /Ben\s*Editor/.test(annMembersText),
      JSON.stringify({ camSpacesText, annMembersText }),
    );

    // 2. Open reading-list in `studio` on Ann, Ben, and Cam.
    await openList(ann.page, server.url);
    await openList(ben.page, server.url);
    await openList(cam.page, server.url);
    await waitSettled(ann.page);
    await waitSettled(ben.page);
    await waitSettled(cam.page);
    await waitRole(cam.page, "reader");

    // Ann adds a shared book via the reading-list form.
    await ann.page.fill(`${FORM} input[name="title"]`, "Hyperion");
    await ann.page.fill(`${FORM} input[name="author"]`, "Simmons");
    await ann.page.click(`${FORM} button[type="submit"]`);
    const reachedBen = await hasTitle(ben.page, "Hyperion", 15000);
    const reachedCam = await hasTitle(cam.page, "Hyperion", 15000);
    await waitSettled(ann.page);
    await waitSettled(ben.page);
    await waitSettled(cam.page);
    check("space RBAC: a reader joins the space and receives synced records", reachedBen && reachedCam);

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

    // 5. Reader write refusal: Cam (reader) tries to add a book on the page, and over raw WebSocket push/plugin/app messages.
    await waitSettled(cam.page);
    await waitRole(cam.page, "reader");
    await cam.page.fill(`${FORM} input[name="title"]`, "Reader Attempt");
    await cam.page.click(`${FORM} button[type="submit"]`);
    const noticeText = await cam.page.waitForSelector("#notice p", { timeout: 8000 }).then((p) => p.textContent(), () => "");
    await cam.page.waitForTimeout(600);
    const camSync = await syncState(cam.page);
    const leakedToAnn = await hasTitle(ann.page, "Reader Attempt", 1000);

    const camCookies = await cam.context.cookies(server.url);
    const camCookieHeader = camCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const rawCam = await rawSyncClient(server.url, "studio", camCookieHeader);
    const rawPushReply = await rawCam.ask(
      "push",
      { changes: [{ collection: "library", id: "reader-raw-1", base: 0, after: { id: "reader-raw-1", title: "Raw Reader Book" } }] },
      "pushed",
    );
    const pluginListReply = await rawCam.ask("plugins", { action: "list" });
    const pluginAddReply = await rawCam.ask("plugins", {
      action: "add",
      app: "demos/reading-list",
      files: [{ name: "v.js", text: 'export const manifest = { id: "v", name: "V", permissions: [] };\nexport default () => {};' }],
    });
    const appShareReply = await rawCam.ask("apps", { action: "share", name: "vapp", files: [{ name: "app.html", text: "<!doctype html>" }] });
    rawCam.close();

    const refusalRe = /You can read this space but not change it/;
    check(
      "space RBAC: a reader's local write, record push, plugin add, and app share are refused without keeping drafts",
      !leakedToAnn &&
        refusalRe.test(noticeText ?? "") &&
        camSync.drafts.length === 0 &&
        rawPushReply?.results?.[0]?.ok === false &&
        rawPushReply?.results?.[0]?.denied === true &&
        refusalRe.test(rawPushReply?.results?.[0]?.error ?? "") &&
        pluginListReply?.ok === true &&
        pluginAddReply?.ok === false &&
        refusalRe.test(pluginAddReply?.error ?? "") &&
        appShareReply?.ok === false &&
        refusalRe.test(appShareReply?.error ?? ""),
      JSON.stringify({ noticeText, drafts: camSync.drafts, rawPushReply, pluginListReply, pluginAddReply, appShareReply }),
    );

    // 6. Content-addressed blob sync (`sync.putBlob` / `sync.getBlob`) across Ann (owner), Ben (editor), and Cam (reader).
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

    const readerBlobCheck = await runInPlugin(
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
      "blob sync: sync.putBlob and sync.getBlob sync small and multi-chunk binary blobs across devices with SHA-256 verification, allow readers to read but only owners/editors to write, and enforce permissions",
      putResult.ok &&
        /^[0-9a-f]{64}$/.test(smallHash) &&
        putResult.value.a.size === 12 &&
        putResult.value.b.size === 600 * 1024 &&
        getOnBen.ok &&
        JSON.stringify(getOnBen.value.smallBytes) === JSON.stringify([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 42, 99]) &&
        getOnBen.value.smallType === "image/png" &&
        getOnBen.value.largeMatches === true &&
        getOnBen.value.missing === null &&
        readerBlobCheck.ok &&
        readerBlobCheck.value.readSize === 12 &&
        refusalRe.test(readerBlobCheck.value.writeError ?? "") &&
        deniedBlobCheck.ok === false &&
        /Missing capability/.test(deniedBlobCheck.error ?? ""),
      JSON.stringify({ putResult, getOnBen, readerBlobCheck, deniedBlobCheck }),
    );

    // 7. Role switching (`/auth/spaces/<name>/role`) & MCP agent-key RBAC:
    //    readers cannot mint agent keys; non-owners get 403 on role switch; promoting reader -> editor enables writes & keys; demoting revokes keys.
    const readerKeyAttempt = await fetch(`${server.url}/auth/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url, cookie: camCookieHeader },
      body: JSON.stringify({ space: "studio", name: "Reader MCP" }),
    });
    const benCookies = await ben.context.cookies(server.url);
    const benCookieHeader = benCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const camMe = await fetch(`${server.url}/auth/me`, { headers: { cookie: camCookieHeader } }).then((r) => r.json());
    const camId = camMe?.user?.id;
    const benTriesRole = await fetch(`${server.url}/auth/spaces/studio/role`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url, cookie: benCookieHeader },
      body: JSON.stringify({ user: camId, role: "editor" }),
    });
    const annCookies = await ann.context.cookies(server.url);
    const annCookieHeader = annCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const annPromotesCam = await fetch(`${server.url}/auth/spaces/studio/role`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url, cookie: annCookieHeader },
      body: JSON.stringify({ user: camId, role: "editor" }),
    });
    // Wait for Cam's connection to reopen with role === "editor".
    await waitRole(cam.page, "editor");
    const editorKeyMint = await fetch(`${server.url}/auth/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url, cookie: camCookieHeader },
      body: JSON.stringify({ space: "studio", name: "Editor MCP" }),
    });
    await cam.page.fill(`${FORM} input[name="title"]`, "Cam Is Editor Now");
    await cam.page.click(`${FORM} button[type="submit"]`);
    const camBookReachedAnn = await hasTitle(ann.page, "Cam Is Editor Now", 15000);
    // Demoting Cam back to reader revokes Cam's space agent keys.
    const annDemotesCam = await fetch(`${server.url}/auth/spaces/studio/role`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url, cookie: annCookieHeader },
      body: JSON.stringify({ user: camId, role: "reader" }),
    });
    const camKeysAfterDemote = await fetch(`${server.url}/auth/keys`, { headers: { cookie: camCookieHeader } }).then((r) => r.json());
    check(
      "space RBAC: readers cannot mint MCP keys, only owners switch roles via /auth/spaces/<name>/role, promoting to editor enables writes, and demoting back to reader revokes space keys",
      readerKeyAttempt.status === 403 &&
        benTriesRole.status === 403 &&
        annPromotesCam.status === 200 &&
        editorKeyMint.status === 200 &&
        camBookReachedAnn &&
        annDemotesCam.status === 200 &&
        (camKeysAfterDemote?.keys ?? []).length === 0,
      JSON.stringify({
        readerKeyStatus: readerKeyAttempt.status,
        benStatus: benTriesRole.status,
        annStatus: annPromotesCam.status,
        editorKeyStatus: editorKeyMint.status,
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
