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
import { authenticator } from "./authenticator.mjs";

const results = [];

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
      return serve({ port: 0, host: "127.0.0.1", spaces, site: "dist", kernel: ".build/server/space.js" });
    },
    wrote: (space) => existsSync(join(spaces, space, "files", "user", "demos", "contacts", "hello-space.js")),
  }),
  cloudflare: (spaces) => ({
    async start() {
      const port = await freePort();
      const dev = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", spaces, "--var", "SPACES:open", "--show-interactive-dev-session=false"], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, CI: "1" } });
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
    async closedByDefault() {
      const port = await freePort();
      const dev = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", spaces, "--show-interactive-dev-session=false"], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, CI: "1" } });
      try {
        for (let i = 0; i < 60; i++) {
          const answer = await fetch(`http://127.0.0.1:${port}/s/family/kernel`).catch(() => undefined);
          if (answer) return answer.status === 403;
          await new Promise((r) => setTimeout(r, 1000));
        }
        return false;
      } finally {
        try {
          process.kill(-dev.pid, "SIGTERM");
        } catch {}
      }
    },
  }),
};

/** A client of a space's kernel: hello as a tab would, then commands that answer. */
async function client(base, space) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/s/${space}/kernel`);
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

/** Sign-in with passkeys (src/server/auth/), as a browser on this site would do it, and as others might try. */
async function signInChecks(base, check) {
  let cookie = "";
  const call = async (path, body, { origin = base, keep = true } = {}) => {
    const headers = { "content-type": "application/json", cookie };
    if (origin) headers.origin = origin;
    const res = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie?.().find((c) => c.startsWith("ewa-session="));
    if (set && keep) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json().catch(() => null), set };
  };
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
    cookie = "";
    const k = authenticator({ alg, counting: false });
    const made = await call("/auth/register", await k.create((await call("/auth/register/options", { name: alg })).body, base));
    cookie = "";
    const again = await call("/auth/signin", await k.get((await call("/auth/signin/options", {})).body, base));
    results[alg] = `${made.status}/${again.status}`;
  }
  check("sign-in: passkeys that sign with Ed25519 or RSA work too, and ones that keep no counter", Object.values(results).every((r) => r === "200/200"), JSON.stringify(results));

  // Two answers to one challenge at once, from a passkey that keeps no counter: only one signs in.
  cookie = "";
  const still = authenticator({ counting: false });
  await call("/auth/register", await still.create((await call("/auth/register/options", { name: "Still" })).body, base));
  cookie = "";
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
  cookie = "";
  const long = authenticator();
  const longMade = await call("/auth/register", await long.create((await call("/auth/register/options", { name: "Long" })).body, base, { idLength: 600 }));
  cookie = "";
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

    const a = await client(server.url, "family");
    await new Promise((r) => setTimeout(r, 300));
    const welcome = a.heard.find((m) => m.t === "welcome");
    check("a client joins a space's kernel and is welcomed as a tab is, with no plugin workers to start", welcome?.mode === "server" && welcome.spawner === false, JSON.stringify(welcome));
    const reference = await a.command("reference");
    check("the space's kernel is the browser's kernel: it describes the same services", reference?.data && JSON.stringify(reference.data).includes('"data"'));
    const source = 'export const manifest = { id: "hello-space", name: "Hello", permissions: [] };\nexport default () => {};';
    const added = await a.command("user:add", { app: "demos/contacts", files: [{ name: "hello-space.js", data: source }] });
    check("a client's change is written to the space's folder", added?.ok && host.wrote("family"), JSON.stringify(added));
    const other = await client(server.url, "work");
    const otherList = await other.command("user:list", { app: "demos/contacts" });
    check("spaces are separate", Array.isArray(otherList) && otherList.length === 0, JSON.stringify(otherList));
    a.close();
    other.close();

    // Start again: the space's kernel reads its folder back.
    await server.stop();
    server = await host.start();
    const b = await client(server.url, "family");
    const listed = await b.command("user:list", { app: "demos/contacts" });
    check("after a restart, the space has what was written to it", Array.isArray(listed) && listed.some((p) => p.id === "hello-space"), JSON.stringify(listed));
    b.close();

    await signInChecks(server.url, check);

    if (host.closedByDefault) {
      const closed = await host.closedByDefault();
      check("without SPACES=open (as in production, until sign-in), clients can't join a space", closed);
    }

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
    const ownOrigin = await upgrade("/s/family/kernel", { origin: server.url });
    const otherSite = await upgrade("/s/family/kernel", { origin: "https://elsewhere.example" });
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

    const c = await client(server.url, "tabs");
    const tabPlugin = 'export const manifest = { id: "per-tab", name: "Per tab", scope: "tab", permissions: [] };\nexport default () => {};';
    const startedAt = Date.now();
    await c.command("user:add", { app: "demos/contacts", files: [{ name: "per-tab.js", data: tabPlugin }] });
    check("a client of a space isn't asked to start a tab-scoped plugin's worker", !c.heard.some((m) => m.t === "spawn") && Date.now() - startedAt < 3000, JSON.stringify(c.heard.map((m) => m.t)));
    // Left open, so stopping the server must close it.
  } catch (error) {
    check("the checks ran to the end", false, error?.stack ?? String(error));
  } finally {
    const stopping = server?.stop();
    const stopped = await Promise.race([stopping?.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
    check("the server stops while a client is still connected", stopped !== false);
    await rm(spaces, { recursive: true, force: true });
  }
}

const only = process.argv[2];
for (const [name, make] of Object.entries(hosts)) if (!only || only === name) await suite(name, make);

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.what}${r.detail && !r.ok ? `  (${r.detail})` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} server checks passed`);
process.exit(failed ? 1 : 0);
