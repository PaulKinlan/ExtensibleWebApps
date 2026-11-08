// Checks for the hosts that run a space's kernel: Node (src/server/serve.ts)
// and Cloudflare (src/server/cloudflare/, under `wrangler dev`). On each, the
// browser's kernel runs a space, a client talks to it over a WebSocket as a
// tab talks to its kernel, and what it writes is in the space after a restart.
// Needs the site built (npm run build, which builds the Cloudflare kernel too)
// and the Node kernel built (npm run build:server). The main test run calls it
// (tests/checks/space-server.mjs).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";
import { providersFrom } from "../../src/server/auth/providers.ts";
import { authenticator } from "./authenticator.mjs";
import { fakeProvider } from "./fake-oauth.mjs";

const results = [];
// Another site to sign in with, which both hosts are configured to use.
const fake = await fakeProvider();

/** A free port on this machine. */
const freePort = () =>
  new Promise((done) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

/** Each host: start it on a folder of spaces (again, for a restart), and say where its own folder for a space is. */
const hosts = {
  node: (spaces) => ({
    async start() {
      return serve({ port: 0, host: "127.0.0.1", spaces, site: "dist", kernel: ".build/server/space.js", providers: providersFrom(fake.env) });
    },
    wrote: (space) => existsSync(join(spaces, space, "files", "user", "demos", "contacts", "hello-space.js")),
  }),
  cloudflare: (spaces) => ({
    async start() {
      const port = await freePort();
      const dev = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", spaces, ...Object.entries(fake.env).flatMap(([k, v]) => ["--var", `${k}:${v}`]), "--show-interactive-dev-session=false"], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, CI: "1" } });
      let log = "";
      await new Promise((ready, fail) => {
        const timer = setTimeout(() => fail(new Error(`wrangler dev didn't start: ${log.slice(-500)}`)), 60_000);
        const hear = (chunk) => {
          log += chunk;
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
        async stop() {
          try {
            process.kill(-dev.pid, "SIGTERM");
          } catch {}
          await new Promise((r) => setTimeout(r, 1000));
        },
      };
    },
    // A Durable Object's database is the space's folder, so what was written shows in the space, after a restart.
    wrote: () => true,
  }),
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
    close: () => ws.close(),
  };
}

/** Someone using the site's /auth/ routes, with their own cookie: `account()` signs them up with a passkey. */
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
  const signIn = async ({ dropState = false } = {}) => {
    const start = await get(`${base}/auth/oauth/fake/start`);
    const atProvider = await get(start.headers.get("location"));
    if (dropState) jar.delete("ewa-oauth");
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

const only = process.argv[2];
process.on("exit", () => fake.close());
for (const [name, make] of Object.entries(hosts)) if (!only || only === name) await suite(name, make);

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.what}${r.detail && !r.ok ? `  (${r.detail})` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} server checks passed`);
process.exit(failed ? 1 : 0);
