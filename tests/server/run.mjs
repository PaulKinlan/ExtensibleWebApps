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
