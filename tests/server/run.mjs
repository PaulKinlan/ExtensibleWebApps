// Checks for the hosts that run a space's kernel: Node (src/server/serve.ts)
// and Cloudflare (src/server/cloudflare/, under `wrangler dev`). On each, the
// browser's kernel runs a space, a client talks to it over a WebSocket as a
// tab talks to its kernel, and what it writes is in the space after a restart.
// Needs the site built (npm run build, which builds the Cloudflare kernel too)
// and the Node kernel built (npm run build:server). The main test run calls it
// (tests/checks/space-server.mjs).

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "../../src/server/serve.ts";
import { providersFrom } from "../../src/server/auth/providers.ts";
import { providerModules } from "../../src/server/auth/providers/index.ts";
import { smtpMailer } from "../../src/server/smtp.ts";
import { fakeSmtp } from "./fake-smtp.mjs";
import { authenticator } from "./authenticator.mjs";
import { blueskyChecks } from "./bluesky.mjs";
import { mcpChecks } from "./mcp.mjs";
import { fakeAtproto } from "./fake-atproto.mjs";
import { fakeProvider } from "./fake-oauth.mjs";

const results = [];
// Another site to sign in with, which both hosts are configured to use.
const fake = await fakeProvider();
// And Bluesky, on a small AT Protocol network of its own (tests/server/bluesky.mjs).
const atproto = await fakeAtproto();
fake.env.AUTH_PROVIDERS = JSON.stringify([...JSON.parse(fake.env.AUTH_PROVIDERS), atproto.entry]);
// A mail server the Node host sends server plugins' email to (src/server/smtp.ts). Cloudflare's, under wrangler dev, only logs it.
const mailbox = await fakeSmtp();
const FROM = "Spaces <spaces@example.com>";

/** A free port on this machine. */
const freePort = () =>
  new Promise((done) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

let site;

/**
 * The built site, with tests/fixtures/server-app/ at /server-app/: an app with a plugin that runs on the
 * space's server. (Wrangler serves dist/ itself, so on Cloudflare the fixture is copied in instead.)
 */
async function siteWithFixtures() {
  const site = await mkdtemp(join(tmpdir(), "ewa-site-"));
  // dist/server-app is the Cloudflare host's copy of the fixture, there while it runs.
  for (const name of readdirSync("dist")) if (name !== "server-app") symlinkSync(resolve("dist", name), join(site, name));
  symlinkSync(resolve("tests/fixtures/server-app"), join(site, "server-app"));
  return site;
}

/** Each host: start it on a folder of spaces (again, for a restart), and say where its own folder for a space is. */
const hosts = {
  node: (spaces) => ({
    async start() {
      site ??= await siteWithFixtures();
      // 127.0.0.1, as written, is the one private host server plugins may reach here (the network guard's checks use it).
      return serve({ port: 0, host: "127.0.0.1", spaces, site, kernel: ".build/server/space.js", providers: providersFrom(fake.env, providerModules), allowPrivate: ["127.0.0.1"], email: smtpMailer({ url: `smtp://127.0.0.1:${mailbox.port}`, from: FROM }) });
    },
    /** Whether a message with this subject went out to `to`, with these words. */
    /** The text of the last message sent to an address. */
    lastText: (to) => mailbox.received.filter((m) => m.to.some((t) => t.toLowerCase() === to)).at(-1)?.text,
    mailed: (subject, to, text) => mailbox.received.some((m) => m.subject === subject && m.to.some((t) => t.toLowerCase() === to) && (text === undefined || m.text === text) && m.from === "spaces@example.com"),
    wrote: (space) => existsSync(join(spaces, space, "files", "user", "demos", "contacts", "hello-space.js")),
  }),
  cloudflare: (spaces) => {
    /** Everything each wrangler dev printed, across restarts. */
    let printed = "";
    return {
    async start() {
      cpSync("tests/fixtures/server-app", "dist/server-app", { recursive: true });
      const port = await freePort();
      const dev = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", spaces, ...Object.entries({ ...fake.env, EMAIL_FROM: FROM }).flatMap(([k, v]) => ["--var", `${k}:${v}`]), "--show-interactive-dev-session=false"], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, CI: "1" } });
      let log = "";
      await new Promise((ready, fail) => {
        const timer = setTimeout(() => fail(new Error(`wrangler dev didn't start: ${log.slice(-500)}`)), 60_000);
        const hear = (chunk) => {
          log += chunk;
          printed += chunk;
          if (log.includes("Ready on")) {
            clearTimeout(timer);
            ready();
          }
        };
        dev.stdout.on("data", hear);
        dev.stderr.on("data", hear);
        dev.on("exit", () => fail(new Error(`wrangler dev stopped: ${log.slice(-500)}`)));
      });
      return {
        url: `http://127.0.0.1:${port}`,
        /** What wrangler dev has printed, since the first start: its stand-in for Cloudflare Email Service logs each message. */
        log: () => printed,
        async stop() {
          // Wait for it to go, so the next one doesn't open the spaces' databases while this one still has them.
          const gone = new Promise((r) => (dev.exitCode !== null ? r() : dev.once("exit", r)));
          try {
            process.kill(-dev.pid, "SIGTERM");
          } catch {}
          await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))]);
          await new Promise((r) => setTimeout(r, 500));
          rmSync("dist/server-app", { recursive: true, force: true });
        },
      };
    },
    // A Durable Object's database is the space's folder, so what was written shows in the space, after a restart.
    wrote: () => true,
    // wrangler dev writes each message's text to a file and logs where.
    lastText: (to) => {
      const plain = printed.replace(/\x1b\[[0-9;]*m/g, "");
      const found = [...plain.matchAll(/To: ([^\n]*)\n[^]*?Text: (\S+\.txt)/g)].filter((m) => m[1].toLowerCase().includes(to)).at(-1);
      return found ? readFileSync(found[2], "utf8") : undefined;
    },
    mailed: (subject, to) => new RegExp(`send_email binding called[^]*?To: ${to}[^]*?Subject: ${subject}`, "i").test(printed),
    };
  },
};

/** A client of a space's kernel: hello as a tab would, then commands that answer. */
async function client(base, space, cookie) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/s/${space}/kernel`, { headers: { cookie } });
  const heard = [];
  const waiting = new Map();
  let id = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    heard.push(m);
    if (m.t === "command:result") waiting.get(m.id)?.(m.value);
  };
  await new Promise((open, fail) => {
    ws.onopen = open;
    ws.onerror = () => fail(new Error("Couldn't connect"));
  });
  ws.send(JSON.stringify({ t: "hello", tab: `client-${Math.random().toString(36).slice(2)}` }));
  return {
    heard,
    command: (name, arg) =>
      new Promise((answer, fail) => {
        const n = ++id;
        waiting.set(n, answer);
        setTimeout(() => fail(new Error(`No answer to ${name}`)), 5000);
        ws.send(JSON.stringify({ t: "command", id: n, name, arg }));
      }),
    /** Sends any message, as a tab would. */
    send: (message) => ws.send(JSON.stringify(message)),
    close: () => ws.close(),
  };
}

/** A device that syncs with a space: says hello as a tab, then speaks sync (src/shared/sync.ts). */
async function device(base, space, cookie, { claim } = {}) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/s/${space}/kernel`, { headers: { cookie } });
  const heard = [];
  const waiting = new Map();
  let id = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t !== "sync") return;
    if (m.op === "pushed") {
      waiting.get(m.id)?.(m.results);
      waiting.delete(m.id);
    }
    else heard.push(m);
  };
  await new Promise((open, fail) => {
    ws.onopen = open;
    ws.onerror = () => fail(new Error("Couldn't connect"));
  });
  ws.send(JSON.stringify({ t: "hello", tab: `device-${Math.random().toString(36).slice(2)}`, ...(claim ? { member: claim } : {}) }));
  const settle = () => new Promise((r) => setTimeout(r, 300));
  return {
    /** Every change heard, in order. */
    changes: () => heard.filter((m) => m.op === "changes").flatMap((m) => m.changes),
    heard,
    /** Says an app was opened on this device in the space. */
    app: (app) => ws.send(JSON.stringify({ t: "sync", op: "app", app })),
    async hello(since = 0) {
      ws.send(JSON.stringify({ t: "sync", op: "hello", since }));
      await settle();
    },
    push: (changes) =>
      new Promise((answer, fail) => {
        const n = ++id;
        const timer = setTimeout(() => {
          waiting.delete(n);
          fail(new Error("No answer to a push"));
        }, 5000);
        waiting.set(n, (results) => {
          clearTimeout(timer);
          answer(results);
        });
        ws.send(JSON.stringify({ t: "sync", op: "push", id: n, changes }));
      }),
    settle,
    close: () => ws.close(),
  };
}

/** Sync (std/spaces/hub.ts): the space orders changes from its members' devices, refuses stale ones, and lets a device catch up. */
/** Space plugins (std/spaces/plugins.ts): the space keeps what members share, tells every device, and never runs it. */
async function sharedPluginChecks(base, check, owner) {
  const cal = await person(base).account("Cal");
  await owner.call("/auth/spaces", { name: "club" });
  await cal.call("/auth/invites/accept", { token: (await owner.call("/auth/spaces/club/invite", {})).body?.token });
  const ownerId = (await owner.call("/auth/me")).body?.user?.id;
  const mine = await client(base, "club", owner.cookie);
  const theirs = await client(base, "club", cal.cookie);
  let n = 0;
  const ask = (who, request) => {
    const id = ++n;
    who.send({ t: "sync", op: "plugins", id, ...request });
    return new Promise((done) => {
      const end = Date.now() + 5000;
      const look = () => {
        const reply = who.heard.find((m) => m.op === "plugins:reply" && m.id === id);
        if (reply || Date.now() > end) return done(reply);
        setTimeout(look, 50);
      };
      look();
    });
  };
  for (const who of [mine, theirs]) who.send({ t: "sync", op: "hello", since: 0 });
  await new Promise((r) => setTimeout(r, 300));

  // A plugin that would answer a public route if the space ran it.
  const source = `export const manifest = { id: "club-note", name: "Club note", runs: "both", permissions: ["routes"], files: ["club-note.html"] };
export default (ctx) => { ctx.routes.add("GET", "club-note", () => ({ text: "ran on the server" })); };`;
  const shared = await ask(mine, { action: "add", app: "demos/contacts", files: [{ name: "club-note.js", text: source }, { name: "club-note.html", text: "<template>hi</template>" }] });
  await new Promise((r) => setTimeout(r, 300));
  const told = theirs.heard.some((m) => m.op === "plugins:changed");
  const listed = await ask(theirs, { action: "list" });
  const got = await ask(theirs, { action: "get", app: "demos/contacts", plugin: "club-note" });
  const entry = listed?.list?.find((p) => p.id === "club-note");
  check(
    "space plugins: a plugin a member shares is kept by the space, every device hears of it, and another member gets its files, saying who shared it",
    shared?.ok && typeof shared.hash === "string" && told && entry?.app === "demos/contacts" && entry.by === ownerId && entry.hash === shared.hash && got?.files?.length === 2 && got.files[0].text === source,
    JSON.stringify({ shared, told, listed, got: got && { ok: got.ok, files: got.files?.map((f) => f.name) } }),
  );

  mine.send({ t: "sync", op: "app", app: "demos/contacts" });
  await new Promise((r) => setTimeout(r, 1000));
  const routes = await Promise.all(["/s/club/demos/contacts/club-note", "/s/club/user/demos/contacts/club-note", "/s/club/club-note"].map((path) => fetch(`${base}${path}`).then((r) => r.text(), () => "")));
  check("space plugins: the space never runs a plugin a member shared, even one that says it runs on the server", routes.every((text) => !text.includes("ran on the server")));

  const two = await ask(mine, { action: "add", app: "demos/contacts", files: [{ name: "a.js", text: source }, { name: "b.js", text: source.replace("club-note", "other-note") }] });
  const big = await ask(mine, { action: "add", app: "demos/contacts", files: [{ name: "club-note.js", text: source }, { name: "club-note.html", text: "x".repeat(800_000) }] });
  const badApp = await ask(mine, { action: "add", app: "../etc", files: [{ name: "club-note.js", text: source }] });
  const notPlugin = await ask(mine, { action: "add", app: "demos/contacts", files: [{ name: "club-note.js", text: "export default 1;" }] });
  const unlisted = await ask(mine, { action: "add", app: "demos/contacts", files: [{ name: "club-note.js", text: source }, { name: "club-note.html", text: "<template></template>" }, { name: "stray.txt", text: "x" }] });
  const clash = await ask(theirs, {
    action: "add",
    app: "demos/contacts",
    files: [{ name: "other-note.js", text: 'export const manifest = { id: "other-note", name: "Other", permissions: [], files: ["club-note.html"] };\nexport default () => {};' }, { name: "club-note.html", text: "<template>mine now</template>" }],
  });
  const kept = await ask(theirs, { action: "get", app: "demos/contacts", plugin: "club-note" });
  check(
    "space plugins: the space refuses two plugins at once, one over 700 KB, an app that isn't a folder, a file that isn't a plugin, a file its manifest doesn't list, and a file another plugin has",
    [two, big, badApp, notPlugin, unlisted, clash].every((r) => r && r.ok === false && r.error) && kept?.files?.find((f) => f.name === "club-note.html")?.text === "<template>hi</template>",
    JSON.stringify([two, big, badApp, notPlugin, unlisted, clash].map((r) => r?.error)),
  );

  // A new version that no longer lists its template: the old template goes, and others' lists change.
  const leaner = source.replace(', files: ["club-note.html"]', "");
  const changed = await ask(mine, { action: "add", app: "demos/contacts", files: [{ name: "club-note.js", text: leaner }] });
  const now = await ask(theirs, { action: "get", app: "demos/contacts", plugin: "club-note" });
  const relisted = await ask(theirs, { action: "list" });
  check(
    "space plugins: a new version replaces the old, leaving none of the files it no longer lists, with a new hash",
    changed?.ok && changed.hash !== shared?.hash && now?.files?.length === 1 && now.files[0].text === leaner && relisted?.list?.find((p) => p.id === "club-note")?.hash === changed.hash,
    JSON.stringify({ changed, files: now?.files?.map((f) => f.name) }),
  );

  const before = theirs.heard.filter((m) => m.op === "plugins:changed").length;
  const removed = await ask(theirs, { action: "remove", app: "demos/contacts", plugin: "club-note" });
  await new Promise((r) => setTimeout(r, 300));
  const after = await ask(mine, { action: "list" });
  check(
    "space plugins: any member can remove a shared plugin, and every device hears it went",
    removed?.ok && !after?.list?.some((p) => p.id === "club-note") && mine.heard.some((m) => m.op === "plugins:changed") && theirs.heard.filter((m) => m.op === "plugins:changed").length > before,
    JSON.stringify({ removed, after }),
  );
  mine.close();
  theirs.close();
}

async function syncChecks(base, check, owner, restart) {
  const bea = await person(base).account("Bea");
  await owner.call("/auth/spaces", { name: "shared" });
  await bea.call("/auth/invites/accept", { token: (await owner.call("/auth/spaces/shared/invite", {})).body?.token });
  const ids = { owner: (await owner.call("/auth/me")).body?.user?.id, bea: (await bea.call("/auth/me")).body?.user?.id };

  const phone = await device(base, "shared", owner.cookie);
  const laptop = await device(base, "shared", bea.cookie, { claim: ids.owner });
  await phone.hello(0);
  await laptop.hello(0);
  const first = await phone.push([{ collection: "books", id: "dune", base: 0, after: { id: "dune", title: "Dune" } }]);
  await laptop.settle();
  const heard = laptop.changes().find((c) => c.id === "dune");
  check(
    "sync: a change one member's device sends gets the space's next number, and reaches another member's device, saying who made it",
    first?.[0]?.ok && first[0].seq === 1 && heard?.seq === 1 && heard.after?.title === "Dune" && heard.by === ids.owner,
    JSON.stringify({ first, heard }),
  );

  const stale = await laptop.push([{ collection: "books", id: "dune", base: 0, after: { id: "dune", title: "Dune Messiah" } }]);
  const newer = await laptop.push([{ collection: "books", id: "dune", base: 1, after: { id: "dune", title: "Dune (1965)" } }]);
  await phone.settle();
  const byBea = phone.changes().find((c) => c.seq === 2);
  check(
    "sync: a change made from an older version is refused as stale, with the record as the space has it; one made from the latest is accepted",
    stale?.[0]?.stale && stale[0].version === 1 && stale[0].record?.title === "Dune" && newer?.[0]?.ok && newer[0].seq === 2,
    JSON.stringify({ stale, newer }),
  );
  check("sync: a device can't say it is another member: the server says who it is", byBea?.by === ids.bea, JSON.stringify(byBea));
  const told = (d) => d.heard.find((m) => m.op === "changes")?.member;
  check("sync: the space's answer to hello tells each device which member it is", told(phone) === ids.owner && told(laptop) === ids.bea, JSON.stringify({ phone: told(phone), laptop: told(laptop) }));
  const names = phone.heard.find((m) => m.op === "changes")?.members;
  check("sync: the space's answer to hello names its members, by the names on their accounts", names?.[ids.owner] === "Owner" && names?.[ids.bea] === "Bea" && Object.keys(names).length === 2, JSON.stringify(names));
  // Household's stamps.js, on the space's server: a stamp must be the member who sent the change. A space of its own, so the sequence numbers below stay as they are.
  await owner.call("/auth/spaces", { name: "house" });
  await bea.call("/auth/invites/accept", { token: (await owner.call("/auth/spaces/house/invite", {})).body?.token });
  const annPhone = await device(base, "house", owner.cookie);
  const beaPhone = await device(base, "house", bea.cookie);
  await annPhone.hello(0);
  await beaPhone.hello(0);
  annPhone.app("demos/household");
  await new Promise((r) => setTimeout(r, 1500));
  const forged = await beaPhone.push([{ collection: "groceries", id: "forged", base: 0, after: { id: "forged", item: "Caviar", addedBy: ids.owner } }]);
  const honest = await beaPhone.push([{ collection: "groceries", id: "honest", base: 0, after: { id: "honest", item: "Tea", addedBy: ids.bea } }]);
  const kept = await annPhone.push([{ collection: "groceries", id: "honest", base: honest?.[0]?.seq ?? 0, after: { id: "honest", item: "Green tea", addedBy: ids.bea } }]);
  annPhone.close();
  beaPhone.close();
  check(
    "household: the space refuses a change signed with another member's id, and takes one signed by its sender, or that leaves someone's stamp as it was",
    /signed by the member who makes it/.test(forged?.[0]?.error ?? "") && honest?.[0]?.ok && kept?.[0]?.ok,
    JSON.stringify({ forged, honest, kept }),
  );
  const stamped = laptop.changes().find((c) => c.seq === 1)?.after;
  check("sync: a record sent without timestamps is stored with them, as every record has", typeof stamped?.createdAt === "string" && typeof stamped?.updatedAt === "string", JSON.stringify(stamped));

  const bad = await phone.push([{ collection: "Not A Name", id: "x", base: 0, after: { id: "x" } }, { collection: "books", id: "gone", base: 0, after: null }, { collection: "books", id: "dune", base: 2, after: null }]);
  check("sync: a change that isn't well formed is refused, and a delete is a change like any other", bad?.[0]?.error && bad[1]?.ok && bad[2]?.ok && bad[2].seq === 4, JSON.stringify(bad));
  phone.close();
  laptop.close();

  // A device that was away catches up from the last number it saw, after the space has restarted too.
  const url = await restart();
  const away = await device(url, "shared", bea.cookie);
  await away.hello(1);
  const caught = away.changes().map((c) => c.seq);
  const again = await away.push([{ collection: "books", id: "dune", base: 4, after: { id: "dune", title: "Back" } }]);
  check("sync: a device that was away gets every change after the last one it saw, kept across a restart", JSON.stringify(caught) === "[2,3,4]" && again?.[0]?.ok && again[0].seq === 5, JSON.stringify({ caught, again }));
  away.close();

  const outsider = await person(url).account("Out");
  check("sync: someone who isn't a member can't connect to sync", !(await opens(url, "shared", outsider.cookie)));
}

/** Server plugins (std/spaces/server-apps.ts): an app's plugin that runs on the space's server, in an isolate. */
async function serverPluginChecks(base, check, owner, restart, host) {
  await owner.call("/auth/spaces", { name: "guarded" });
  const phone = await device(base, "guarded", owner.cookie);
  await phone.hello(0);
  phone.app("server-app");
  // The space reads the app's app.html and starts guard.js; until then a memo that says "forbidden" gets in.
  let refused;
  for (let i = 0; i < 40 && !refused; i++) {
    const answer = await phone.push([{ collection: "memos", id: `try-${i}`, base: 0, after: { id: `try-${i}`, title: "A forbidden word" } }]);
    if (!answer?.[0]?.ok) refused = answer[0];
    else await new Promise((r) => setTimeout(r, 250));
  }
  const fine = await phone.push([{ collection: "memos", id: "fine", base: 0, after: { id: "fine", title: "A fine word" } }]);
  check("server plugins: an app's plugin with runs: \"server\" starts in the space when a device opens the app there, and its data:beforeWrite stops a device's change", /Guard: that word/.test(refused?.error ?? "") && fine?.[0]?.ok, JSON.stringify({ refused, fine }));
  const ownerId = (await owner.call("/auth/me")).body?.user?.id;
  check("server plugins: a server plugin's data:beforeWrite hears which member's device sent the change, as `by`", !!ownerId && refused?.error?.includes(`(from ${ownerId})`), JSON.stringify({ refused, ownerId }));

  await phone.settle();
  const reach = phone.changes().find((c) => c.id === "reach");
  const said = JSON.parse(reach?.after?.title ?? "{}");
  check("server plugins: what a server plugin writes reaches every device, as a change by that plugin", reach?.by === "plugin:guard", JSON.stringify(reach));
  check(
    "server plugins: a server plugin runs in a sandbox with no Node modules, no process and no network",
    said["node:fs"] === "refused" && said["node:child_process"] === "refused" && said["node:net"] === "refused" && said.process === "undefined" && said.fetch === "undefined",
    JSON.stringify(said),
  );

  // Public routes: a server plugin's route answers anyone, signed in or not, from any site.
  const posted = await fetch(`${base}/s/guarded/server-app/entry`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://elsewhere.example" }, body: "text=Hello+from+outside" });
  let entry;
  for (let i = 0; i < 20 && !entry; i++) {
    await phone.settle();
    entry = phone.changes().find((c) => c.id?.startsWith("entry-"));
    if (!entry) await new Promise((r) => setTimeout(r, 100));
  }
  check(
    "server plugins: a server plugin's route at /s/<space>/<app>/… answers anyone, from any site, and what it writes reaches devices",
    posted.status === 303 && posted.headers.get("location")?.endsWith("/s/guarded/server-app/thanks") && entry?.by === "plugin:inbox" && entry.after?.text === "Hello from outside",
    JSON.stringify({ status: posted.status, location: posted.headers.get("location"), entry }),
  );
  const counted = await fetch(`${base}/s/guarded/server-app/count`).then((r) => r.json(), () => null);
  const unrouted = await fetch(`${base}/s/guarded/server-app/nothing-here`);
  const nowhere = await fetch(`${base}/s/nobody-here/server-app/count`);
  const big = await fetch(`${base}/s/guarded/server-app/entry`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `text=${"x".repeat(70_000)}` });
  check(
    "server plugins: a route answers GET too; a path no plugin answers, or a space that doesn't exist, is the site's as before; a body over 64 KB is refused",
    counted?.count === 1 && unrouted.status === 404 && nowhere.status === 404 && big.status === 413,
    JSON.stringify({ counted, unrouted: unrouted.status, nowhere: nowhere.status, big: big.status }),
  );
  // Email: a server plugin with `email` sends it (written down in the space's outbox), checked, and only so much a day.
  const notify = (body) => fetch(`${base}/s/guarded/server-app/notify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json(), () => null);
  // Mail goes only to the space's members, at the address they gave on their account.
  const stranger = await notify({ to: "sam@example.com", subject: "Before Sam is a member's address", text: "x" });
  const badEmail = await owner.call("/auth/me/email", { email: "not an address" });
  const pathEmail = await owner.call("/auth/me/email", { email: "sam@example.com/path" });
  const setEmail = await owner.call("/auth/me/email", { email: "sam@example.com" });
  const shown = (await owner.call("/auth/me")).body?.user?.email;
  // Saved isn't confirmed: anyone could type someone else's address. A link is mailed to it.
  const unconfirmed = await notify({ to: "sam@example.com", subject: "Before Sam confirms", text: "x" });
  // The message's log line can come a moment after the answer: wait for it.
  let link;
  for (let i = 0; i < 50 && !link; i++) {
    link = /\/account\/\?confirm=([A-Za-z0-9_-]+)/.exec(host.lastText("sam@example.com") ?? "")?.[1];
    if (!link) await new Promise((r) => setTimeout(r, 200));
  }
  const confirmAs = (token) => fetch(`${base}/auth/me/email/confirm`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ token }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const wrongLink = await confirmAs("x".repeat(43));
  const confirmed = await confirmAs(link);
  const used = await confirmAs(link);
  const nowConfirmed = (await owner.call("/auth/me")).body?.user?.emailConfirmed;
  check(
    "accounts: a saved address gets a link to confirm it, and isn't mailed until it's opened (with no sign-in needed, once); a wrong or used link confirms nothing",
    setEmail.body?.sent === true && /only to the space's members/.test(unconfirmed?.error ?? "") && !!link && wrongLink.status === 400 && confirmed.status === 200 && used.status === 400 && nowConfirmed === true,
    JSON.stringify({ setEmail: setEmail.body, unconfirmed, link: !!link, wrongLink, confirmed, used, nowConfirmed }),
  );
  const mailed = await notify({ to: "Sam@Example.com", subject: "3 new answers", text: "See them in the space." });
  const mixed = await notify({ to: ["sam@example.com", "someone@elsewhere.example"], subject: "x", text: "x" });
  check(
    "server plugins: email goes only to the space's members, at the address they gave on their account (any case); anyone else is refused, and an account's address is checked",
    /only to the space's members/.test(stranger?.error ?? "") && badEmail.status === 400 && pathEmail.status === 400 && setEmail.status === 200 && shown === "sam@example.com" && mailed?.ok === true && /someone@elsewhere\.example isn't one/.test(mixed?.error ?? ""),
    JSON.stringify({ stranger, badEmail: badEmail.status, pathEmail: pathEmail.status, setEmail: setEmail.status, shown, mailed, mixed }),
  );
  const badTo = await notify({ to: ["not an address"], subject: "x", text: "x" });
  const badDomain = await notify({ to: ["sam@example..com"], subject: "x", text: "x" });
  const badControl = await notify({ to: ["sam\u0000@example.com"], subject: "x", text: "x" });
  const badSubject = await notify({ to: ["sam@example.com"], subject: "Two\nlines", text: "x" });
  const tooMany = await notify({ to: Array.from({ length: 11 }, (_, i) => `p${i}@example.com`), subject: "x", text: "x" });
  check(
    "server plugins: a plugin with `email` sends a message, and hears it was delivered; a bad address, a subject of two lines or more than 10 people is refused",
    mailed?.ok === true && typeof mailed.id === "string" && mailed.delivered === true && /address/.test(badTo?.error) && /address/.test(badDomain?.error) && /address/.test(badControl?.error) && /one line/.test(badSubject?.error) && /at most 10/.test(tooMany?.error),
    JSON.stringify({ mailed, badTo, badDomain, badControl, badSubject, tooMany }),
  );
  let day = 1;
  let limited;
  for (let tries = 0; tries < 60 && !limited; tries++) {
    const answer = await notify({ to: "sam@example.com", subject: `Message ${day + 1}`, text: "x" });
    if (answer?.ok) day++;
    else limited = answer ?? { error: "no answer" };
  }
  check("server plugins: a plugin sends at most 50 messages a day", day === 50 && /50 messages a day/.test(limited?.error ?? ""), JSON.stringify({ day, limited }));
  const form = new FormData();
  form.append("text", "Sent as multipart");
  form.append("file", new Blob(["ignored"]), "note.txt");
  const multipart = await fetch(`${base}/s/guarded/server-app/entry`, { method: "POST", redirect: "manual", body: form });
  const head = await fetch(`${base}/s/guarded/server-app/count`, { method: "HEAD" });
  const twice = await fetch(`${base}/s/guarded/server-app/count`).then((r) => r.json(), () => null);
  check(
    "server plugins: a multipart form reaches a route as its string fields, and HEAD is answered by the GET route",
    multipart.status === 303 && head.status === 200 && head.headers.get("content-type")?.startsWith("application/json") && twice?.count === 2,
    JSON.stringify({ multipart: multipart.status, head: head.status, twice }),
  );
  // A scheduled job runs on the server, and what it writes reaches devices.
  let tick;
  for (let i = 0; i < 40 && !(tick?.after?.n >= 2); i++) {
    await new Promise((r) => setTimeout(r, 250));
    await phone.settle();
    tick = phone.changes().filter((c) => c.collection === "ticks" && c.id === "count").at(-1);
  }
  check("server plugins: a job a server plugin schedules with ctx.schedule.every runs on the server, again and again", tick?.after?.n >= 2 && tick.by === "plugin:ticker", JSON.stringify(tick));
  const tamper = phone.changes().find((c) => c.collection === "ticks" && c.id === "tamper")?.after;
  check("server plugins: a plugin can't rewrite the space's jobs as a file, even with files:schedule", !!tamper?.refused, JSON.stringify(tamper));
  check("server plugins: a plugin linked only inside an HTML comment doesn't start on the server", !phone.changes().some((c) => c.collection === "ghosts"), JSON.stringify(phone.changes().filter((c) => c.collection === "ghosts")));
  phone.close();

  // A member's client can't run its own code on the server, or replace the app's plugin.
  const c = await client(base, "guarded", owner.cookie);
  const mine = 'export const manifest = { id: "guard", name: "Mine", permissions: [] };\nexport default () => {};';
  // Opening an app with its own copy of the plugin, as a tab would.
  c.send({ t: "open", plugins: [{ href: `${base}/server-app/guard.js`, source: mine }], app: "server-app" });
  await new Promise((r) => setTimeout(r, 500));
  const open = c.heard.find((m) => m.t === "opened");
  const stillGuarded = await device(base, "guarded", owner.cookie);
  await stillGuarded.hello(0);
  const after = await stillGuarded.push([{ collection: "memos", id: "again", base: 0, after: { id: "again", title: "Forbidden again" } }]);
  check("server plugins: a member's client can't replace a space's server plugin with its own source", !after?.[0]?.ok && /Guard/.test(after[0].error ?? ""), JSON.stringify({ open, after }));
  stillGuarded.close();
  c.close();

  // The space starts its apps' server plugins again when it restarts, with no device asking.
  const url = await restart();
  const stoppedAt = Date.now();
  // The ticker's job starts the space again by itself, with no device or request: a device that connects
  // later finds ticks made after the restart.
  await new Promise((r) => setTimeout(r, 4000));
  const watcher = await device(url, "guarded", owner.cookie);
  await watcher.hello(0);
  const ticked = watcher.changes().filter((c) => c.collection === "ticks" && c.id === "count").at(-1);
  const firstTick = watcher.changes().find((c) => c.collection === "ticks" && c.id === "count" && c.after?.at > stoppedAt);
  check(
    "server plugins: after a restart, a scheduled job starts the space by itself and keeps running, with no one connected",
    !!firstTick && firstTick.after.at < Date.now() - 1000 && ticked?.after?.at > stoppedAt,
    JSON.stringify({ firstTick, ticked, stoppedAt }),
  );
  watcher.close();
  // With the ticker's job stopped, a restart leaves the space cold: a request to a public route wakes it,
  // with no device connected.
  const stopped = await fetch(`${url}/s/guarded/server-app/stop`, { method: "POST" }).then((r) => r.json(), () => null);
  const coldUrl = await restart();
  const woken = await fetch(`${coldUrl}/s/guarded/server-app/count`).then((r) => r.json(), () => null);
  check("server plugins: a public route wakes a space that isn't running, and its plugin answers", stopped?.stopped && woken?.count === 2, JSON.stringify({ stopped, woken }));
  const later = await device(coldUrl, "guarded", owner.cookie);
  await later.hello(0);
  let again;
  for (let i = 0; i < 40 && !again; i++) {
    const answer = await later.push([{ collection: "memos", id: `later-${i}`, base: 0, after: { id: `later-${i}`, title: "Forbidden later" } }]);
    if (!answer?.[0]?.ok) again = answer[0];
    else await new Promise((r) => setTimeout(r, 250));
  }
  check("server plugins: after a restart the space starts its apps' server plugins again by itself", /Guard/.test(again?.error ?? ""), JSON.stringify(again));
  later.close();
}

/** Someone using the site's /auth/ routes, with their own cookie: `account()` signs them up with a passkey. */
/** The survey demo (demos/survey/), a proof app: a survey made on a device is answered at its public address, on the server. */
async function surveyChecks(base, check, owner) {
  await owner.call("/auth/spaces", { name: "polls" });
  const laptop = await device(base, "polls", owner.cookie);
  await laptop.hello(0);
  laptop.app("demos/survey");
  const made = await laptop.push([{ collection: "surveys", id: "lunch", base: 0, after: { id: "lunch", title: "Lunch <b>Friday</b>", questions: "Where to: Cafe | Park\nAnything else?", open: true } }]);
  const address = `${base}/s/polls/demos/survey/answer?survey=lunch`;
  let form = "";
  for (let i = 0; i < 40 && !form.includes("<form"); i++) {
    form = await fetch(address).then((r) => r.text(), () => "");
    if (!form.includes("<form")) await new Promise((r) => setTimeout(r, 250));
  }
  check(
    "survey demo: a survey made on a device is a public form on the space's server, with what its author typed escaped",
    made?.[0]?.ok && form.includes('<form method="post"') && form.includes('value="Park"') && form.includes("Lunch &lt;b&gt;Friday&lt;/b&gt;") && !form.includes("<b>Friday"),
    form.slice(0, 300),
  );
  const post = (body) => fetch(address, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://elsewhere.example" }, body });
  const sent = await post("q1=Park&q2=Bring+cake");
  const odd = await post("q1=The+moon");
  let answer;
  for (let i = 0; i < 20 && !answer; i++) {
    await laptop.settle();
    answer = laptop.changes().find((c) => c.collection === "answers");
  }
  check(
    "survey demo: anyone's answers are kept on the server and reach the members' devices; a choice the survey doesn't offer is refused",
    sent.status === 200 && (await sent.text()).includes("are in") && answer?.by === "plugin:collect" && answer.after?.survey === "lunch" && answer.after.values?.q1 === "Park" && answer.after.values.q2 === "Bring cake" && answer.after.asked?.q1 === "Where to" && answer.after.asked.q2 === "Anything else?" && odd.status === 400,
    JSON.stringify({ sent: sent.status, odd: odd.status, answer }),
  );
  const closed = await laptop.push([{ collection: "surveys", id: "lunch", base: made[0].seq, after: { id: "lunch", title: "Lunch <b>Friday</b>", questions: "Where to: Cafe | Park", open: false } }]);
  const after = await fetch(address).then((r) => r.text());
  const late = await post("q1=Cafe");
  check("survey demo: a survey that stops taking answers says so, and takes none", closed?.[0]?.ok && /isn't taking answers/.test(after) && late.status === 404, JSON.stringify({ closed, late: late.status }));
  laptop.close();
}

/** On Node, a server plugin with `network` reaches the internet but not the server's own network (src/server/network-guard.ts). */
async function networkGuardChecks(base, check) {
  // A server on this machine: / says hello, and /hop redirects to the same server by the name localhost.
  const local = createHttpServer((req, res) => {
    if (req.url === "/hop") return res.writeHead(302, { location: `http://localhost:${local.address().port}/` }).end();
    if (req.url === "/hop-ip") return res.writeHead(307, { location: `http://[::ffff:7f00:1]:${local.address().port}/` }).end();
    res.end("hello from inside");
  });
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const port = local.address().port;
  const probe = (url, how) => fetch(`${base}/s/guarded/server-app/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, how }) }).then((r) => r.json(), (e) => ({ ok: false, error: String(e) }));
  const seen = {
    byName: await probe(`http://localhost:${port}/`),
    ipv6: await probe(`http://[::1]:${port}/`),
    mapped: await probe(`http://[::ffff:127.0.0.1]:${port}/`),
    metadata: await probe("http://169.254.169.254/latest/meta-data/"),
    redirect: await probe(`http://127.0.0.1:${port}/hop`),
    redirectToIp: await probe(`http://127.0.0.1:${port}/hop-ip`),
    allowed: await probe(`http://127.0.0.1:${port}/`),
  };
  // Around fetch: the dispatcher it uses, and an Agent the plugin makes itself, are refused where the socket connects.
  const around = {
    dispatcher: await probe(`http://[::ffff:7f00:1]:${port}/`, "dispatcher"),
    agent: await probe(`http://[::ffff:7f00:1]:${port}/`, "agent"),
    metadata: await probe("http://169.254.169.254/latest/meta-data/", "agent"),
    tampered: await probe(`http://[::1]:${port}/`, "tampered"),
  };
  local.close();
  const refused = (r) => r?.ok === false && /server's own network/.test(r.error);
  check(
    "network guard: a server plugin with network can't reach the server's own network: localhost, ::1, a mapped address, the metadata service, or a redirect inside",
    refused(seen.byName) && refused(seen.ipv6) && refused(seen.mapped) && refused(seen.metadata) && refused(seen.redirect) && refused(seen.redirectToIp),
    JSON.stringify(seen),
  );
  check(
    "network guard: going around fetch, through its dispatcher or an Agent of the plugin's own, or after replacing Set.prototype.has and other built-ins, is refused too",
    Object.values(around).every((r) => r?.ok === false && (r.code === "EACCES" || r.code === "EPRIVATE")),
    JSON.stringify(around),
  );
  check("network guard: a private host the deployment allows is reached", seen.allowed?.ok && seen.allowed.text === "hello from inside", JSON.stringify(seen.allowed));
}

/**
 * The feed reader (demos/feeds/), a proof app, on Node: an https feed server on this machine (allowed, and its
 * certificate trusted through NODE_EXTRA_CA_CERTS, which the server passes to its plugins), and feeds a device adds.
 */
async function feedChecks(base, check, owner) {
  const LONG = `atom-${"x".repeat(59)}`;
  const folder = await mkdtemp(join(tmpdir(), "feeds-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(folder, "key.pem"), "-out", join(folder, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  } catch {
    return check("feed reader: openssl makes a certificate for the https feed server (skipped: no openssl)", true);
  }
  process.env.NODE_EXTRA_CA_CERTS = join(folder, "cert.pem");
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Local &amp; news</title>
<item><title>First story</title><link>https://example.com/1</link><guid>one</guid><pubDate>Sat, 07 Nov 2026 09:00:00 GMT</pubDate><description><![CDATA[<p>Hello <b>there</b><script>alert(1)</script></p>]]></description></item>
<item><title>Second &lt;story&gt;</title><link>javascript:alert(1)</link><guid>two</guid><pubDate>Sun, 08 Nov 2026 09:00:00 GMT</pubDate><description>Plain words</description></item>
</channel></rss>`;
  // Atom with a prefix on every element, and relative links: one against the entry's xml:base, one against the feed's address.
  const atom = `<?xml version="1.0"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>Prefixed</atom:title>
<atom:entry xml:base="https://example.org/blog/"><atom:title>Based</atom:title><atom:id>b</atom:id><atom:link href="posts/1"/><atom:updated>2026-11-06T09:00:00Z</atom:updated></atom:entry>
<atom:entry><atom:title>Relative</atom:title><atom:id>r</atom:id><atom:link rel="alternate" href="/top"/><atom:updated>2026-11-05T09:00:00Z</atom:updated></atom:entry>
</atom:feed>`;
  const feeds = createHttpsServer({ key: readFileSync(join(folder, "key.pem")), cert: readFileSync(join(folder, "cert.pem")) }, (req, res) => {
    if (req.url === "/to-http") return res.writeHead(302, { location: `http://127.0.0.1:${feeds.address().port}/rss.xml` }).end();
    if (req.url === "/atom.xml") return res.writeHead(200, { "content-type": "application/atom+xml" }).end(atom);
    res.writeHead(200, { "content-type": "application/rss+xml" }).end(rss);
  });
  await new Promise((r) => feeds.listen(0, "127.0.0.1", r));
  const at = `https://127.0.0.1:${feeds.address().port}`;
  await owner.call("/auth/spaces", { name: "news" });
  const phone = await device(base, "news", owner.cookie);
  await phone.hello(0);
  phone.app("demos/feeds");
  const added = await phone.push([
    { collection: "feeds", id: "local", base: 0, after: { id: "local", url: `${at}/rss.xml` } },
    { collection: "feeds", id: "plain", base: 0, after: { id: "plain", url: `http://127.0.0.1:${feeds.address().port}/rss.xml` } },
    { collection: "feeds", id: "away", base: 0, after: { id: "away", url: `${at}/to-http` } },
    // As long as an id may be: a story's id must still fit.
    { collection: "feeds", id: LONG, base: 0, after: { id: LONG, url: `${at}/atom.xml` } },
  ]);
  const latest = (collection, id) => phone.changes().filter((c) => c.collection === collection && c.id === id).at(-1)?.after;
  let items = [];
  let atomItems = [];
  for (let i = 0; i < 60 && !(items.length >= 2 && atomItems.length >= 2 && latest("fetched", "plain") && latest("fetched", "away")); i++) {
    await new Promise((r) => setTimeout(r, 250));
    await phone.settle();
    items = phone.changes().filter((c) => c.collection === "items" && c.after?.feed === "local");
    atomItems = phone.changes().filter((c) => c.collection === "items" && c.after?.feed === LONG);
  }
  feeds.close();
  const first = items.find((c) => c.after.title === "First story")?.after;
  const second = items.find((c) => c.after.title === "Second <story>")?.after;
  const local = latest("fetched", "local");
  check(
    "feed reader: a feed a device adds is read on the space's server over https, and its stories reach the device as plain text",
    added.every((a) => a.ok) && items.every((c) => c.by === "plugin:fetch") && local?.title === "Local & news" && !local.error && first?.link === "https://example.com/1" && first.summary === "Hello there" && first.published === "2026-11-07T09:00:00.000Z" && second && !second.link && second.summary === "Plain words",
    JSON.stringify({ local, first, second, count: items.length }),
  );
  check(
    "feed reader: a feed at http://, or one that redirects there, isn't read",
    /Only https/.test(latest("fetched", "plain")?.error ?? "") && /redirected away from https/.test(latest("fetched", "away")?.error ?? ""),
    JSON.stringify({ plain: latest("fetched", "plain"), away: latest("fetched", "away") }),
  );
  const based = atomItems.find((c) => c.after.title === "Based")?.after;
  const relative = atomItems.find((c) => c.after.title === "Relative")?.after;
  check(
    "feed reader: an Atom feed with prefixed elements is read, its relative links made whole, and a feed with a 64-character id still keeps its stories",
    latest("fetched", LONG)?.title === "Prefixed" && based?.link === "https://example.org/blog/posts/1" && relative?.link === `${at}/top` && atomItems.every((c) => c.id.length <= 64),
    JSON.stringify({ fetched: latest("fetched", LONG), based, relative }),
  );
  phone.close();
  delete process.env.NODE_EXTRA_CA_CERTS;
  await rm(folder, { recursive: true, force: true });
}

function person(base) {
  const me = {
    cookie: "",
    /** Where the site is (a restarted host listens somewhere new). */
    base,
    async call(path, body, { origin = me.base, keep = true } = {}) {
      const headers = { "content-type": "application/json", cookie: me.cookie };
      if (origin) headers.origin = origin;
      const res = await fetch(`${me.base}${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.getSetCookie?.().find((c) => c.startsWith("ewa-session="));
      if (set && keep) me.cookie = set.split(";")[0];
      return { status: res.status, body: await res.json().catch(() => null), set };
    },
    async account(name) {
      const key = authenticator();
      await me.call("/auth/register", await key.create((await me.call("/auth/register/options", { name })).body, base));
      return me;
    },
  };
  return me;
}

/** Whether a WebSocket to a space opens, for someone with this cookie. */
const opens = (base, space, cookie = "") =>
  new Promise((done) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/s/${space}/kernel`, { headers: { cookie } });
    ws.onopen = () => (ws.close(), done(true));
    ws.onerror = () => done(false);
  });

/** Signing in with another site (src/server/auth/providers.ts), here the fake one: the redirects a browser follows, one by one. */
async function oauthChecks(base, check) {
  const jar = new Map();
  const keep = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const [name, value] = pair.split("=");
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    return res;
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const get = async (url, extra = {}) => keep(await fetch(url, { redirect: "manual", headers: { cookie: cookie(), ...extra } }));
  /** Start, go to the provider, come back: where the callback sends the browser. */
  const signIn = async ({ dropState = false, query = "", meanwhile } = {}) => {
    const start = await get(`${base}/auth/oauth/fake/start${query}`);
    const atProvider = await get(start.headers.get("location"));
    if (dropState) jar.delete("ewa-oauth");
    await meanwhile?.();
    const back = await get(atProvider.headers.get("location"));
    return { status: back.status, location: back.headers.get("location") };
  };
  const me = async () => (await (await get(`${base}/auth/me`)).json()).user;

  const listed = await (await get(`${base}/auth/providers`)).json();
  fake.as = { id: 7, name: "Fake Person" };
  const first = await signIn();
  const who = await me();
  jar.clear();
  const again = await signIn();
  const sameAccount = (await me())?.id === who?.id;
  check(
    "other sites: a configured provider is listed, signs in with a new account named from its profile, and the same person comes back to it",
    listed.providers?.some((p) => p.id === "fake" && p.name === "Fake") && first.status === 303 && first.location === "/account/" && who?.name === "Fake Person" && again.status === 303 && sameAccount,
    JSON.stringify({ listed, first, who, again, sameAccount }),
  );

  jar.clear();
  const forged = await signIn({ dropState: true });
  check("other sites: a sign-in this browser didn't start is refused", forged.status === 303 && /error=/.test(forged.location ?? "") && !(await me()), JSON.stringify(forged));

  // Linking: someone signed in with a passkey adds this provider's account to theirs.
  jar.clear();
  const key = authenticator();
  const options = await (await fetch(`${base}/auth/register/options`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ name: "Linker" }) })).json();
  keep(await fetch(`${base}/auth/register`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(await key.create(options, base)) }));
  const linker = await me();
  fake.as = { id: 8, name: "Linker Elsewhere" };
  const link = await signIn();
  const stillLinker = (await me())?.id === linker?.id;
  jar.clear();
  await signIn();
  const viaProvider = (await me())?.id === linker?.id;
  // Signed in as Linker, Fake Person's identity (which has its own account) can't be linked too.
  fake.as = { id: 7, name: "Fake Person" };
  const taken = await signIn();
  const stillLinkerAfter = (await me())?.id === linker?.id;
  check(
    "other sites: someone signed in can link a provider's account to theirs (not one that is someone else's), and then sign in with either",
    linker?.name === "Linker" && link.status === 303 && link.location === "/account/" && stillLinker && viaProvider && /error=/.test(taken.location ?? "") && stillLinkerAfter,
    JSON.stringify({ linker, link, stillLinker, viaProvider, taken, stillLinkerAfter }),
  );

  // Linking started, then signed out before coming back: nothing is linked.
  fake.as = { id: 9, name: "Too Late" };
  const late = await signIn({ meanwhile: async () => keep(await fetch(`${base}/auth/signout`, { method: "POST", headers: { origin: base, cookie: cookie() } })) });
  jar.clear();
  const fresh = await signIn();
  const notLinked = (await me())?.id !== linker?.id;
  // An invite in /account/'s address goes along, and comes back to be accepted.
  jar.clear();
  const token = "i".repeat(24);
  const invited = await signIn({ query: `?invite=${token}` });
  check(
    "other sites: a link finished after signing out is refused, and an invite comes back to /account/ after signing in",
    /error=/.test(late.location ?? "") && fresh.status === 303 && notLinked && invited.location === `/account/?invite=${token}`,
    JSON.stringify({ late, notLinked, invited }),
  );

  const parsed = providersFrom({ AUTH_PROVIDERS: JSON.stringify([null, { id: "constructor", clientId: "c", authorize: "https://a.example/a", token: "https://a.example/t", user: "https://a.example/u" }]), CONSTRUCTOR_CLIENT_SECRET: "s" }, providerModules);
  check("other sites: a configuration entry that isn't an object is skipped, and any id without a preset uses its own URLs", parsed.length === 1 && parsed[0].authorize === "https://a.example/a", JSON.stringify(parsed.map((p) => p.authorize)));
}

/** Spaces with members (src/server/auth/accounts.ts): who may make, join, invite to and leave a space. */
async function memberChecks(base, check, owner) {
  const ada = await person(base).account("Ada");
  const taken = await ada.call("/auth/spaces", { name: "family" });
  const badName = await ada.call("/auth/spaces", { name: "Not A Name!" });
  check("members: a space's name is a slug no one else has taken", taken.status === 409 && badName.status === 400, `${taken.status} ${badName.status}`);

  const strangers = { nobody: await opens(base, "family"), ada: await opens(base, "family", ada.cookie), peek: (await ada.call("/auth/spaces/family")).status };
  check("members: someone not signed in, or not in the space, can't join it or see who is", !strangers.nobody && !strangers.ada && strangers.peek === 404, JSON.stringify(strangers));

  const invite = (await owner.call("/auth/spaces/family/invite", {})).body;
  const joined = await ada.call("/auth/invites/accept", { token: invite?.token });
  const again = await person(base).account("Bea").then((bea) => bea.call("/auth/invites/accept", { token: invite?.token }));
  const members = (await owner.call("/auth/spaces/family")).body?.members ?? [];
  const mine = (await ada.call("/auth/spaces")).body?.spaces ?? [];
  check(
    "members: the owner's invite lets one person join, and then they can open the space",
    joined.status === 200 && again.status === 404 && members.some((m) => m.name === "Ada" && m.role === "member") && mine.some((s) => s.name === "family" && s.role === "member") && (await opens(base, "family", ada.cookie)),
    JSON.stringify({ joined, again: again.status, members, mine }),
  );

  const inviteByMember = await ada.call("/auth/spaces/family/invite", {});
  const removeOwner = await ada.call("/auth/spaces/family/leave", { user: members.find((m) => m.role === "owner")?.id });
  const left = await ada.call("/auth/spaces/family/leave", {});
  check("members: only the owner invites, no one removes the owner, and someone who leaves can't open it again", inviteByMember.status === 403 && removeOwner.status === 403 && left.status === 200 && !(await opens(base, "family", ada.cookie)), JSON.stringify([inviteByMember.status, removeOwner.status, left.status]));

  // Asked for at the same moment: one name, one owner; one invite, one person.
  const [dee, eve] = await Promise.all([person(base).account("Dee"), person(base).account("Eve")]);
  const claims = await Promise.all([dee.call("/auth/spaces", { name: "contested" }), eve.call("/auth/spaces", { name: "contested" })]);
  const once = (await owner.call("/auth/spaces/family/invite", {})).body?.token;
  const accepts = await Promise.all([dee.call("/auth/invites/accept", { token: once }), eve.call("/auth/invites/accept", { token: once })]);
  check(
    "members: two people making one space at once get one owner, and two using one invite at once get one member",
    claims.map((r) => r.status).sort().join() === "200,409" && accepts.map((r) => r.status).sort().join() === "200,404",
    JSON.stringify({ claims: claims.map((r) => r.status), accepts: accepts.map((r) => r.status) }),
  );

  // Someone removed while connected is let go at once.
  const cy = await person(base).account("Cy");
  await cy.call("/auth/invites/accept", { token: (await owner.call("/auth/spaces/family/invite", {})).body?.token });
  const closed = await new Promise((done) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/s/family/kernel`, { headers: { cookie: cy.cookie } });
    ws.onclose = (e) => done(e.code);
    ws.onopen = async () => {
      await owner.call("/auth/spaces/family/leave", { user: (await cy.call("/auth/me")).body?.user?.id });
      setTimeout(() => done("still open"), 3000);
    };
  });
  check("members: someone the owner removes from a space is disconnected from it at once", closed === 4403, String(closed));
}

/** Sign-in with passkeys (src/server/auth/), as a browser on this site would do it, and as others might try. */
async function signInChecks(base, check) {
  const someone = person(base);
  const call = (...args) => someone.call(...args);
  const me = async () => (await call("/auth/me")).body?.user;
  const key = authenticator();

  const nameless = await call("/auth/register/options", {});
  const elsewhere = await call("/auth/register/options", { name: "Ada" }, { origin: "https://elsewhere.example" });
  check("sign-in: an account needs a name, and only this site's pages may ask for one", nameless.status === 400 && elsewhere.status === 403, JSON.stringify([nameless, elsewhere]));

  const options = (await call("/auth/register/options", { name: "Ada" })).body;
  const registered = await call("/auth/register", await key.create(options, base));
  const ada = await me();
  check("sign-in: a new passkey makes an account and signs it in, with a session cookie the page's script can't read", registered.status === 200 && ada?.name === "Ada" && /HttpOnly/.test(registered.set ?? "") && /SameSite=Lax/.test(registered.set ?? ""), JSON.stringify(registered));

  await call("/auth/signout", {});
  const out = await call("/auth/me");
  const signin = (await call("/auth/signin/options", {})).body;
  const answer = await key.get(signin, base);
  const back = await call("/auth/signin", answer);
  check("sign-in: signing out ends the session, and the passkey signs back in to the same account", out.status === 401 && back.status === 200 && (await me())?.id === ada?.id, JSON.stringify({ out: out.status, back }));

  const replay = await call("/auth/signin", answer, { keep: false });
  const otherOrigin = await call("/auth/signin", await key.get((await call("/auth/signin/options", {})).body, "https://elsewhere.example"), { keep: false });
  const otherSite = await call("/auth/signin", await key.get((await call("/auth/signin/options", {})).body, base, { rpId: "elsewhere.example" }), { keep: false });
  const backwards = await call("/auth/signin", await key.get((await call("/auth/signin/options", {})).body, base, { counterOverride: 1 }), { keep: false });
  const forged = await key.get((await call("/auth/signin/options", {})).body, base);
  forged.response.signature = forged.response.signature.replace(/^.{8}/, "AAAAAAAA");
  const forgedAnswer = await call("/auth/signin", forged, { keep: false });
  check(
    "sign-in: a used challenge, another page's ceremony, another site's passkey, a counter gone back and a forged signature are all refused",
    replay.status === 400 && otherOrigin.status === 401 && otherSite.status === 401 && backwards.status === 401 && forgedAnswer.status === 401,
    JSON.stringify([replay, otherOrigin, otherSite, backwards, forgedAnswer].map((r) => `${r.status} ${r.body?.error}`)),
  );

  const second = authenticator({ alg: "EdDSA" });
  const more = await call("/auth/register", await second.create((await call("/auth/register/options", {})).body, base));
  check("sign-in: a signed-in person can add another passkey to their account", more.status === 200 && more.body?.user?.id === ada?.id, JSON.stringify(more));

  const results = {};
  for (const alg of ["EdDSA", "RS256"]) {
    someone.cookie = "";
    const k = authenticator({ alg, counting: false });
    const made = await call("/auth/register", await k.create((await call("/auth/register/options", { name: alg })).body, base));
    someone.cookie = "";
    const again = await call("/auth/signin", await k.get((await call("/auth/signin/options", {})).body, base));
    results[alg] = `${made.status}/${again.status}`;
  }
  check("sign-in: passkeys that sign with Ed25519 or RSA work too, and ones that keep no counter", Object.values(results).every((r) => r === "200/200"), JSON.stringify(results));

  // Two answers to one challenge at once, from a passkey that keeps no counter: only one signs in.
  someone.cookie = "";
  const still = authenticator({ counting: false });
  await call("/auth/register", await still.create((await call("/auth/register/options", { name: "Still" })).body, base));
  someone.cookie = "";
  const twice = await still.get((await call("/auth/signin/options", {})).body, base);
  const both = await Promise.all([call("/auth/signin", twice, { keep: false }), call("/auth/signin", twice, { keep: false })]);
  check("sign-in: one answer sent twice at once signs in only once", both.filter((r) => r.status === 200).length === 1, JSON.stringify(both.map((r) => r.status)));

  // Options for one more passkey, asked for while signed in, don't work once that session has ended.
  await call("/auth/signin", await still.get((await call("/auth/signin/options", {})).body, base));
  const addLater = (await call("/auth/register/options", {})).body;
  await call("/auth/signout", {});
  const late = await call("/auth/register", await authenticator().create(addLater, base), { keep: false });
  const nullBody = await fetch(`${base}/auth/register/options`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "null" });
  const huge = await fetch(`${base}/auth/register/options`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ name: "x".repeat(70_000) }) });
  check("sign-in: adding a passkey needs the session that asked to still be signed in; a body that isn't an object, or is too big, is refused", late.status === 401 && nullBody.status === 400 && huge.status === 413, JSON.stringify([late.status, nullBody.status, huge.status]));

  // A passkey's id can be up to 1023 bytes: far too long for a file's name.
  someone.cookie = "";
  const long = authenticator();
  const longMade = await call("/auth/register", await long.create((await call("/auth/register/options", { name: "Long" })).body, base, { idLength: 600 }));
  someone.cookie = "";
  const longBack = await call("/auth/signin", await long.get((await call("/auth/signin/options", {})).body, base));
  check("sign-in: a passkey with a long id registers and signs in", longMade.status === 200 && longBack.status === 200, JSON.stringify([longMade.status, longBack.body?.error ?? longBack.status]));
}

async function suite(name, make) {
  const check = (what, ok, detail = "") => results.push({ what: `${name}: ${what}`, ok: !!ok, detail });
  const spaces = await mkdtemp(join(tmpdir(), "spaces-"));
  const host = make(spaces);
  let server;
  try {
    server = await host.start();
    const page = await fetch(`${server.url}/`);
    const missing = await fetch(`${server.url}/no/such/page`);
    check("the server serves the built site, and its 404 page for a path it hasn't got", page.status === 200 && (await page.text()).includes("<html") && missing.status === 404, `${page.status} ${missing.status}`);

    // Someone with an account, who makes the spaces the checks use.
    const owner = await person(server.url).account("Owner");
    for (const space of ["family", "work", "tabs"]) await owner.call("/auth/spaces", { name: space });

    const a = await client(server.url, "family", owner.cookie);
    await new Promise((r) => setTimeout(r, 300));
    const welcome = a.heard.find((m) => m.t === "welcome");
    check("a client joins a space's kernel and is welcomed as a tab is, with no plugin workers to start", welcome?.mode === "server" && welcome.spawner === false, JSON.stringify(welcome));
    const reference = await a.command("reference");
    check("the space's kernel is the browser's kernel: it describes the same services", reference?.data && JSON.stringify(reference.data).includes('"data"'));
    const source = 'export const manifest = { id: "hello-space", name: "Hello", permissions: [] };\nexport default () => {};';
    const added = await a.command("user:add", { app: "demos/contacts", files: [{ name: "hello-space.js", data: source }] });
    check("a client's change is written to the space's folder", added?.ok && host.wrote("family"), JSON.stringify(added));
    const other = await client(server.url, "work", owner.cookie);
    const otherList = await other.command("user:list", { app: "demos/contacts" });
    check("spaces are separate", Array.isArray(otherList) && otherList.length === 0, JSON.stringify(otherList));
    a.close();
    other.close();

    // Start again: the space's kernel reads its folder back.
    await server.stop();
    server = await host.start();
    owner.base = server.url;
    const b = await client(server.url, "family", owner.cookie);
    const listed = await b.command("user:list", { app: "demos/contacts" });
    check("after a restart, the space has what was written to it", Array.isArray(listed) && listed.some((p) => p.id === "hello-space"), JSON.stringify(listed));
    b.close();

    await signInChecks(server.url, check);

    await memberChecks(server.url, check, owner);
    await oauthChecks(server.url, check);
    await blueskyChecks(server.url, check, atproto);
    await sharedPluginChecks(server.url, check, owner);
    await syncChecks(server.url, check, owner, async () => {
      await server.stop();
      server = await host.start();
      owner.base = server.url;
      return server.url;
    });
    await serverPluginChecks(server.url, check, owner, async () => {
      await server.stop();
      server = await host.start();
      owner.base = server.url;
      return server.url;
    }, host);
    check(
      "email: a server plugin's message to a member is delivered: over SMTP on Node, through Cloudflare Email Service on Cloudflare",
      host.mailed("3 new answers", "sam@example.com", "See them in the space."),
      name === "node" ? JSON.stringify(mailbox.received.slice(0, 2).map(({ raw, ...m }) => m)) : (server.log?.() ?? "").split("\n").filter((l) => /mail|eml|send/i.test(l)).slice(-8).join(" | "),
    );
    // A person can send their saved address a test message, a few a day, to see mail reaches them.
    const tests = [];
    // Five a day from the accounts, and the link to confirm the address was one.
    for (let i = 0; i < 5; i++) tests.push(await owner.call("/auth/me/email/test", {}));
    const subject = `A test message from ${new URL(server.url).host}`;
    check(
      "email: a signed-in person can send their own confirmed address a test message (the accounts send 5 a day), and it's delivered on this host",
      tests.slice(0, 4).every((t) => t.status === 200 && t.body?.ok) && tests[4].status === 429 && host.mailed(subject, "sam@example.com"),
      JSON.stringify(tests.map((t) => [t.status, t.body])),
    );
    await surveyChecks(server.url, check, owner);
    await mcpChecks(server.url, check, owner, await person(server.url).account("Stranger"));

    // Workers can't reach a private network in production; wrangler's local runtime isn't a guide to that.
    if (name === "node") await networkGuardChecks(server.url, check);
    if (name === "node") await feedChecks(server.url, check, owner);

    // Names that aren't a space are refused.
    const refused = await new Promise((done) => {
      const ws = new WebSocket(`${server.url.replace("http", "ws")}/s/..%2Fetc/kernel`);
      ws.onopen = () => done(false);
      ws.onerror = () => done(true);
    });
    check("a space's name can't lead out of the spaces folder", refused);

    // An upgrade's answer, for a request a browser's WebSocket can't make.
    const upgrade = (path, headers = {}) =>
      new Promise((done) => {
        const req = request(`${server.url}${path}`, { headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
        req.on("upgrade", (res, socket) => (socket.destroy(), done(res.statusCode)));
        req.on("response", (res) => (res.resume(), done(res.statusCode)));
        req.on("error", () => done("error"));
        req.end();
      });
    const ownOrigin = await upgrade("/s/family/kernel", { origin: server.url, cookie: owner.cookie });
    const otherSite = await upgrade("/s/family/kernel", { origin: "https://elsewhere.example", cookie: owner.cookie });
    check("a page on another site can't open a space; the server's own pages and clients that aren't browsers can", ownOrigin === 101 && otherSite === 403, JSON.stringify({ ownOrigin, otherSite }));

    const garbled = await new Promise((done) => {
      const { port } = new URL(server.url);
      const raw = connect(Number(port), "127.0.0.1", () => raw.write("GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"));
      raw.on("data", (d) => done(String(d).split("\r\n")[0]));
      raw.on("error", () => done("error"));
      raw.on("close", () => done("closed"));
    });
    const stillUp = await fetch(`${server.url}/`).then((r) => r.status, () => 0);
    check("a request for a garbled address is refused, and the server keeps running", stillUp === 200, `${garbled}, then ${stillUp}`);

    const worker = await fetch(`${server.url}/assets/${(await import("node:fs")).readdirSync("dist/assets").find((f) => /^runtime-.*\.js$/.test(f))}`);
    check("plugin workers get the site's _headers policy, as on Cloudflare", /worker-src 'none'/.test(worker.headers.get("content-security-policy") ?? ""), worker.headers.get("content-security-policy"));

    const c = await client(server.url, "tabs", owner.cookie);
    const tabPlugin = 'export const manifest = { id: "per-tab", name: "Per tab", scope: "tab", permissions: [] };\nexport default () => {};';
    const startedAt = Date.now();
    await c.command("user:add", { app: "demos/contacts", files: [{ name: "per-tab.js", data: tabPlugin }] });
    check("a client of a space isn't asked to start a tab-scoped plugin's worker", !c.heard.some((m) => m.t === "spawn") && Date.now() - startedAt < 3000, JSON.stringify(c.heard.map((m) => m.t)));
    // Left open, so stopping the server must close it.
  } catch (error) {
    check("the checks ran to the end", false, (error?.stack ?? String(error)) + " cause: " + (error?.cause?.stack ?? error?.cause));
  } finally {
    const stopping = server?.stop();
    const stopped = await Promise.race([stopping?.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
    check("the server stops while a client is still connected", stopped !== false);
    await rm(spaces, { recursive: true, force: true });
  }
}

/**
 * Moving a space (src/server/transfer.ts): the feed reader's space, made on Cloudflare, is downloaded by its
 * owner and loaded into an empty space on Node, where it keeps its feeds and the feed reader's server plugin
 * starts again and reads them. Both hosts run at once, each with its own accounts.
 */
async function moveChecks() {
  const check = (what, ok, detail = "") => results.push({ what: `move: ${what}`, ok: !!ok, detail });
  const folders = [await mkdtemp(join(tmpdir(), "move-cf-")), await mkdtemp(join(tmpdir(), "move-node-"))];
  const tls = await mkdtemp(join(tmpdir(), "move-tls-"));
  let cf;
  let node;
  let feeds;
  try {
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(tls, "key.pem"), "-out", join(tls, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
    } catch {
      return check("openssl makes a certificate for the https feed server (skipped: no openssl)", true);
    }
    // The feed reader's plugin runs in a process of its own, which takes the certificate from here.
    process.env.NODE_EXTRA_CA_CERTS = join(tls, "cert.pem");
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Moved news</title><item><title>Still here</title><link>https://example.com/moved</link><guid>m1</guid></item></channel></rss>`;
    feeds = createHttpsServer({ key: readFileSync(join(tls, "key.pem")), cert: readFileSync(join(tls, "cert.pem")) }, (req, res) => res.writeHead(200, { "content-type": "application/rss+xml" }).end(rss));
    await new Promise((r) => feeds.listen(0, "127.0.0.1", r));
    const feedUrl = `https://127.0.0.1:${feeds.address().port}/rss.xml`;

    // On Cloudflare: Ana makes the space, opens the feed reader in it and adds a feed and a note of her own.
    cf = await hosts.cloudflare(folders[0]).start();
    const ana = await person(cf.url).account("Ana");
    await ana.call("/auth/spaces", { name: "news" });
    const phone = await device(cf.url, "news", ana.cookie);
    await phone.hello(0);
    phone.app("demos/feeds");
    const added = await phone.push([{ collection: "feeds", id: "moved", base: 0, after: { id: "moved", url: feedUrl } }]);
    await new Promise((r) => setTimeout(r, 1500));
    phone.close();

    const guest = await person(cf.url).account("Gus");
    await guest.call("/auth/invites/accept", { token: (await ana.call("/auth/spaces/news/invite", {})).body?.token });
    const notOwner = await guest.call("/auth/spaces/news/export");
    const outsider = await person(cf.url).call("/auth/spaces/news/export");
    check("only a space's owner can download it: a member can't, nor someone signed out", notOwner.status === 403 && outsider.status === 401, `${notOwner.status} ${outsider.status}`);

    const exported = await ana.call("/auth/spaces/news/export");
    const copy = exported.body;
    const paths = Object.keys(copy?.files ?? {});
    check(
      "the owner downloads the space from Cloudflare: one file with its collections, change log and the apps opened in it",
      added?.[0]?.ok && exported.status === 200 && copy.format === "extensible-web-apps/space" && copy.space === "news" && paths.length > 0 && paths.some((p) => /apps/.test(p)),
      JSON.stringify({ added, status: exported.status, paths }),
    );

    // On Node: Ana has an account of her own there. A copy goes only into an empty space she owns.
    node = await hosts.node(folders[1]).start();
    const there = await person(node.url).account("Ana");
    await there.call("/auth/spaces", { name: "news" });
    await there.call("/auth/spaces", { name: "busy" });
    const busy = await client(node.url, "busy", there.cookie);
    await busy.command("user:add", { app: "demos/contacts", files: [{ name: "busy.js", data: 'export const manifest = { id: "busy", name: "Busy", permissions: [] };\nexport default () => {};' }] });
    busy.close();
    const intoBusy = await there.call("/auth/spaces/busy/import", copy);
    const garbled = await there.call("/auth/spaces/news/import", { format: "something else" });
    const sneaky = await there.call("/auth/spaces/news/import", { ...copy, files: { "../escape.json": "e30=" } });
    const elsewhere = await there.call("/auth/spaces/news/import", copy, { origin: "https://elsewhere.example" });
    const badData = await there.call("/auth/spaces/news/import", { ...copy, files: { ...copy.files, "zz-last.json": "A" } });
    check(
      "a copy is refused for a space that has things in it, when it isn't a copy, when a path leads out of the folder or a file isn't base64, and from another site's page, writing nothing",
      intoBusy.status === 409 && garbled.status === 400 && sneaky.status === 400 && elsewhere.status === 403 && badData.status === 400,
      JSON.stringify([intoBusy, garbled, sneaky, elsewhere, badData].map((r) => `${r.status} ${r.body?.error}`)),
    );
    const imported = await there.call("/auth/spaces/news/import", copy);
    check("the owner loads the copy into an empty space on Node", imported.status === 200 && imported.body?.files === paths.length, JSON.stringify(imported));

    // The space on Node has the feed, and its server plugin, started by the move with no one connected, reads it.
    const laptop = await device(node.url, "news", there.cookie);
    let items = [];
    let fetched;
    for (let i = 0; i < 60 && !(items.length && fetched && !fetched.error); i++) {
      await laptop.hello(0);
      items = laptop.changes().filter((c) => c.collection === "items" && c.after?.feed === "moved");
      fetched = laptop.changes().filter((c) => c.collection === "fetched" && c.id === "moved").at(-1)?.after;
      await new Promise((r) => setTimeout(r, 500));
    }
    const feed = laptop.changes().find((c) => c.collection === "feeds" && c.id === "moved")?.after;
    laptop.close();
    check(
      "after the move, the space on Node keeps its feed, and the feed reader's server plugin starts again by itself and reads it",
      feed?.url === feedUrl && fetched?.title === "Moved news" && !fetched.error && items.some((c) => c.after.title === "Still here" && c.by === "plugin:fetch"),
      JSON.stringify({ feed, fetched, items: items.length }),
    );
    const again = await there.call("/auth/spaces/news/import", copy);
    check("a copy can't go into the same space twice", again.status === 409, JSON.stringify(again));

    // And back: the space as Node has it now, stories and all, goes into a new space on Cloudflare.
    const back = (await there.call("/auth/spaces/news/export")).body;
    await ana.call("/auth/spaces", { name: "news-back" });
    const loaded = await ana.call("/auth/spaces/news-back/import", back);
    const tablet = await device(cf.url, "news-back", ana.cookie);
    await tablet.hello(0);
    const story = tablet.changes().find((c) => c.collection === "items" && c.after?.title === "Still here");
    tablet.close();
    check("and back: a copy from Node loads into a new space on Cloudflare, with what the space gained on Node", loaded.status === 200 && !!story, JSON.stringify({ loaded, story: !!story }));
  } catch (error) {
    check("the checks ran to the end", false, error?.stack ?? String(error));
  } finally {
    feeds?.close();
    await cf?.stop().catch(() => {});
    await node?.stop().catch(() => {});
    delete process.env.NODE_EXTRA_CA_CERTS;
    for (const folder of [...folders, tls]) await rm(folder, { recursive: true, force: true });
  }
}

/** The SMTP client (src/server/smtp.ts) against a mail server that wants STARTTLS and a password, as a real one does. */
async function smtpChecks() {
  const check = (what, ok, detail = "") => results.push({ what: `smtp: ${what}`, ok: !!ok, detail });
  const tls = await mkdtemp(join(tmpdir(), "smtp-tls-"));
  try {
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(tls, "key.pem"), "-out", join(tls, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
    } catch {
      return check("openssl makes a certificate for the mail server (skipped: no openssl)", true);
    }
    const key = readFileSync(join(tls, "key.pem"));
    const cert = readFileSync(join(tls, "cert.pem"));
    const server = await fakeSmtp({ tls: { key, cert }, login: { user: "apps@example.com", pass: "p@ss:word" } });
    const url = (user, pass) => `smtp://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@localhost:${server.port}`;
    const good = smtpMailer({ url: url("apps@example.com", "p@ss:word"), from: "Apps <apps@example.com>", ca: String(cert) });
    const sent = await good.send({ to: ["ann@example.com", "ben@example.com"], subject: "Café ☕ at 3", text: "Line one\n.\nLine three", html: "<p>Hello</p>" });
    const got = server.received[0];
    check(
      "it upgrades to TLS, signs in, and sends a message with a subject that isn't ASCII, its text and its HTML, to each recipient",
      sent.ok && got?.subject === "Café ☕ at 3" && got.text === "Line one\n.\nLine three" && got.html === "<p>Hello</p>" && got.to.join() === "ann@example.com,ben@example.com" && got.from === "apps@example.com",
      JSON.stringify({ sent, got: got && { ...got, raw: undefined } }),
    );
    const wrong = await smtpMailer({ url: url("apps@example.com", "nope"), from: "apps@example.com", ca: String(cert) }).send({ to: ["ann@example.com"], subject: "x", text: "x" });
    const untrusted = await smtpMailer({ url: url("apps@example.com", "p@ss:word"), from: "apps@example.com" }).send({ to: ["ann@example.com"], subject: "x", text: "x" });
    check("a wrong password, or a mail server whose certificate isn't trusted, is a failure that says so, and nothing is sent", !wrong.ok && /refused/.test(wrong.error) && !untrusted.ok && server.received.length === 1, JSON.stringify({ wrong, untrusted }));
    const many = Array.from({ length: 10 }, (_, i) => `${"someone-with-a-long-name".repeat(9)}${i}@example.com`);
    const long = await good.send({ to: many, subject: "Many", text: "Hi" });
    const lines = server.received.at(-1)?.raw.split("\r\n") ?? [];
    check("ten long recipients go on folded lines, each under SMTP's 1,000-byte limit", long.ok && lines.every((l) => l.length < 998) && server.received.at(-1).headerTo.split(/,\s*/).length === 10, JSON.stringify({ long, longest: Math.max(...lines.map((l) => l.length)) }));
    server.close();
    const stalled = await fakeSmtp({ tls: { key, cert }, stall: true });
    const hung = await smtpMailer({ url: `smtp://localhost:${stalled.port}`, from: "apps@example.com", ca: String(cert), timeout: 500 }).send({ to: ["ann@example.com"], subject: "x", text: "x" });
    check("a mail server that stops answering while starting TLS is a failure after the timeout, not a send that never ends", !hung.ok && /TLS in time/.test(hung.error), JSON.stringify(hung));
    stalled.close();
    let six;
    try {
      six = await fakeSmtp({ host: "::1" });
    } catch {
      check("an IPv6 address in SMTP_URL (skipped: no IPv6 here)", true);
    }
    if (six) {
      const viaSix = await smtpMailer({ url: `smtp://[::1]:${six.port}`, from: "apps@example.com" }).send({ to: ["ann@example.com"], subject: "Six", text: "x" });
      check("an IPv6 address in SMTP_URL ([::1]) connects", viaSix.ok && six.received[0]?.subject === "Six", JSON.stringify(viaSix));
      six.close();
    }
  } finally {
    await rm(tls, { recursive: true, force: true });
  }
}

const only = process.argv[2];
process.on("exit", () => (fake.close(), atproto.close(), mailbox.close()));
for (const [name, make] of Object.entries(hosts)) if (!only || only === name) await suite(name, make);
if (!only || only === "move") await moveChecks();
if (!only || only === "smtp") await smtpChecks();

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.what}${r.detail && !r.ok ? `  (${r.detail})` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} server checks passed`);
process.exit(failed ? 1 : 0);
