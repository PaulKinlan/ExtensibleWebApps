// Checks for the Node host (src/server/serve.ts): the browser's kernel runs a
// space on the server, a client talks to it over a WebSocket as a tab talks
// to its kernel, and what it writes is in the space's folder after a restart.
// Needs the site built (npm run build) and the space kernel built
// (npm run build:server). The main test run calls it (tests/checks/space-server.mjs).

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

const results = [];
const check = (what, ok, detail = "") => results.push({ what, ok: !!ok, detail });
const spaces = await mkdtemp(join(tmpdir(), "spaces-"));
const options = { port: 0, host: "127.0.0.1", spaces, site: "dist", kernel: ".build/server/space.js" };

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

let server;
try {
  server = await serve(options);
  const page = await fetch(`${server.url}/`);
  const missing = await fetch(`${server.url}/no/such/page`);
  check("the server serves the built site, and its 404 page for a path it hasn't got", page.status === 200 && (await page.text()).includes("<html") && missing.status === 404);

  const a = await client(server.url, "family");
  await new Promise((r) => setTimeout(r, 200));
  const welcome = a.heard.find((m) => m.t === "welcome");
  check("a client joins a space's kernel and is welcomed as a tab is, with no plugin workers to start", welcome?.mode === "server" && welcome.spawner === false, JSON.stringify(welcome));
  const reference = await a.command("reference");
  check("the space's kernel is the browser's kernel: it describes the same services", reference?.data && JSON.stringify(reference.data).includes('"data"'));
  const source = 'export const manifest = { id: "hello-space", name: "Hello", permissions: [] };\nexport default () => {};';
  const added = await a.command("user:add", { app: "demos/contacts", files: [{ name: "hello-space.js", data: source }] });
  check("a client's change is written to the space's folder", added?.ok && existsSync(join(spaces, "family", "files", "user", "demos", "contacts", "hello-space.js")), JSON.stringify(added));
  const other = await client(server.url, "work");
  const otherList = await other.command("user:list", { app: "demos/contacts" });
  check("spaces are separate", Array.isArray(otherList) && otherList.length === 0, JSON.stringify(otherList));
  a.close();
  other.close();

  // Start again: the space's kernel reads its folder back.
  await server.stop();
  server = await serve(options);
  const b = await client(server.url, "family");
  const listed = await b.command("user:list", { app: "demos/contacts" });
  check("after a restart, the space has what was written to it", Array.isArray(listed) && listed.some((p) => p.id === "hello-space"), JSON.stringify(listed));
  b.close();

  // Names that aren't a space are refused.
  const refused = await new Promise((done) => {
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/s/..%2Fetc/kernel`);
    ws.onopen = () => done(false);
    ws.onerror = () => done(true);
  });
  check("a space's name can't lead out of the spaces folder", refused);
} catch (error) {
  check("the checks ran to the end", false, error?.stack ?? String(error));
} finally {
  await server?.stop();
  await rm(spaces, { recursive: true, force: true });
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.what}${r.detail && !r.ok ? `  (${r.detail})` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} server checks passed`);
process.exit(failed ? 1 : 0);
