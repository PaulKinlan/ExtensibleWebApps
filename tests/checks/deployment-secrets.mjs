// Deployment-managed secrets (src/kernel/secrets.ts, src/kernel/net.ts,
// src/server/space-env.ts): a space's server reads keys from DEPLOYMENT_SECRETS
// or EWA_SECRET_<NAME> + EWA_SECRET_<NAME>_HOSTS and lets trusted server
// plugins use them in net.fetch without ever reading their values, enforcing
// secret:<name>, host allowlists, response redaction, and a daily request cap.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "../../src/server/serve.ts";
import { authenticator } from "../server/authenticator.mjs";

function echoServer() {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const auth = req.headers.authorization ?? "";
      received.push({ url: req.url, authorization: auth, body });
      res
        .writeHead(200, { "content-type": "application/json", "x-echo-auth": auth })
        .end(JSON.stringify({ echoedAuth: auth, body }));
    });
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({
        port: server.address().port,
        received,
        close: () => new Promise((r) => server.close(r)),
      }),
    ),
  );
}

function person(base) {
  const me = {
    cookie: "",
    async call(path, body) {
      const headers = { "content-type": "application/json", cookie: me.cookie, origin: base };
      const res = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.getSetCookie?.().find((c) => c.startsWith("ewa-session="));
      if (set) me.cookie = set.split(";")[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async account(name) {
      const key = authenticator();
      await me.call("/auth/register", await key.create((await me.call("/auth/register/options", { name })).body, base));
      return me;
    },
  };
  return me;
}

export default async function ({ a, check, plugin, pluginLog }) {
  if (!existsSync("dist")) {
    const built = spawnSync("npm", ["run", "-s", "build"], { encoding: "utf8", timeout: 120_000 });
    if (built.status !== 0) throw new Error(`build failed: ${built.stderr}`);
  }
  if (!existsSync(".build/server/space.js")) {
    const built = spawnSync("npm", ["run", "-s", "build:server"], { encoding: "utf8", timeout: 120_000 });
    if (built.status !== 0) throw new Error(`build:server failed: ${built.stderr}`);
  }

  const apiA = await echoServer();
  const apiB = await echoServer();
  const hostA = `127.0.0.1:${apiA.port}`;
  const hostB = `127.0.0.1:${apiB.port}`;
  const spaces = await mkdtemp(join(tmpdir(), "ewa-dep-secrets-spaces-"));
  const site = await mkdtemp(join(tmpdir(), "ewa-dep-secrets-site-"));

  const envKeys = ["DEPLOYMENT_SECRETS", "EWA_SECRET_ALT_KEY", "EWA_SECRET_ALT_KEY_HOSTS"];
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  let host;

  try {
    for (const name of readdirSync("dist")) if (name !== "secret-app") symlinkSync(resolve("dist", name), join(site, name));
    const appDir = join(site, "secret-app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "app.html"),
      `<!doctype html><meta charset="utf-8"><title>Secret app</title>
<link rel="stylesheet" href="/platform/host.css">
<script type="module" src="/platform/host.js"></script>
<link rel="plugin" href="worker.js">
<link rel="plugin" href="denied.js">
<main><slot name="main"></slot></main>`,
    );
    writeFileSync(
      join(appDir, "worker.js"),
      `export const manifest = {
  id: "secret-worker",
  name: "Secret worker",
  runs: "server",
  permissions: ["routes", "network:${hostA}", "network:${hostB}", "secret:echo", "secret:alt-key", "secret:capped", "secret:missing"],
};
export default (ctx) => {
  ctx.routes.add("GET", "info", async () => {
    const echoBefore = await ctx.call("secrets", "has", "echo");
    const alt = await ctx.call("secrets", "has", "alt-key");
    const missing = await ctx.call("secrets", "has", "missing");
    const forgotten = await ctx.call("secrets", "forget", "echo");
    const echoAfter = await ctx.call("secrets", "has", "echo");
    const requested = await ctx.call("secrets", "request", "echo", { hosts: ["${hostA}"] });
    return { json: { echoBefore, alt, missing, forgotten, echoAfter, requested } };
  });
  ctx.routes.add("POST", "call", async ({ form }) => {
    const { url, secret } = form || {};
    const out = await ctx.call("net", "fetch", {
      url,
      method: "POST",
      headers: { authorization: { secret, prefix: "Bearer " } },
      body: "ping",
    }).then((r) => ({ ok: true, status: r.status, echoHeader: r.headers["x-echo-auth"] ?? "", text: r.text }), (e) => ({ ok: false, error: e.message }));
    return { json: out };
  });
};`,
    );
    writeFileSync(
      join(appDir, "denied.js"),
      `export const manifest = {
  id: "secret-denied",
  name: "Secret denied",
  runs: "server",
  permissions: ["routes", "network:${hostA}"],
};
export default (ctx) => {
  ctx.routes.add("GET", "try", async () => {
    const hasErr = await ctx.call("secrets", "has", "echo").then(() => "allowed", (e) => e.message);
    const netErr = await ctx.call("net", "fetch", {
      url: "http://${hostA}/echo",
      headers: { authorization: { secret: "echo" } },
    }).then(() => "allowed", (e) => e.message);
    return { json: { hasErr, netErr } };
  });
};`,
    );

    const ECHO_SECRET = "sk-deploy-secret-9999";
    const ALT_SECRET = "sk-alt-env-8888";
    const CAPPED_SECRET = "sk-capped-secret-7777";
    process.env.DEPLOYMENT_SECRETS = JSON.stringify({
      echo: { value: ECHO_SECRET, hosts: [hostA] },
      capped: { value: CAPPED_SECRET, hosts: [hostA], dailyCap: 4 },
    });
    process.env.EWA_SECRET_ALT_KEY = ALT_SECRET;
    process.env.EWA_SECRET_ALT_KEY_HOSTS = hostA;

    const startHost = () => serve({ port: 0, host: "127.0.0.1", spaces, site, kernel: ".build/server/space.js", allowPrivate: ["127.0.0.1"] });
    host = await startHost();

    const owner = await person(host.url).account("Owner");
    await owner.call("/auth/spaces", { name: "ops" });

    // Open secret-app in the space so its server plugins start.
    const ws = new WebSocket(`${host.url.replace("http", "ws")}/s/ops/kernel`, { headers: { cookie: owner.cookie } });
    const messages = [];
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    await new Promise((open, fail) => {
      ws.onopen = open;
      ws.onerror = () => fail(new Error("WebSocket failed"));
    });
    ws.send(JSON.stringify({ t: "hello", tab: "dev-1" }));
    ws.send(JSON.stringify({ t: "sync", op: "hello", since: 0 }));
    await new Promise((r) => setTimeout(r, 300));
    ws.send(JSON.stringify({ t: "sync", op: "app", app: "secret-app" }));

    let info;
    for (let i = 0; i < 30 && !info; i++) {
      const res = await fetch(`${host.url}/s/ops/secret-app/info`);
      if (res.ok && res.headers.get("content-type")?.includes("application/json")) info = await res.json();
      else await new Promise((r) => setTimeout(r, 200));
    }
    if (!info) {
      ws.send(JSON.stringify({ t: "command", id: 99, name: "trace" }));
      await new Promise((r) => setTimeout(r, 300));
      ws.close();
      const tr = messages.find((m) => m.t === "command:result" && m.id === 99)?.value;
      throw new Error(`secret-app server routes did not start: ${JSON.stringify(tr?.slice(-15))}`);
    }
    ws.close();
    check(
      "deployment secrets: secrets.has reports { set: true, hosts, managed: true } for DEPLOYMENT_SECRETS and EWA_SECRET_<NAME>, without exposing values",
      info.echoBefore?.set === true &&
        info.echoBefore?.managed === true &&
        JSON.stringify(info.echoBefore?.hosts) === JSON.stringify([hostA]) &&
        !("value" in info.echoBefore) &&
        info.alt?.set === true &&
        info.alt?.managed === true &&
        JSON.stringify(info.alt?.hosts) === JSON.stringify([hostA]) &&
        JSON.stringify(info.missing) === JSON.stringify({ set: false, hosts: [] }),
      JSON.stringify(info),
    );
    check(
      "deployment secrets: secrets.forget does not delete a deployment secret, and secrets.request resolves when covered",
      info.forgotten === true && info.echoAfter?.set === true && info.echoAfter?.managed === true && info.requested?.set === true && info.requested?.managed === true,
      JSON.stringify(info),
    );

    const postCall = (url, secret) =>
      fetch(`${host.url}/s/ops/secret-app/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, secret }),
      }).then((r) => r.json());

    const allowedCall = await postCall(`http://${hostA}/v1/messages`, "echo");
    const altCall = await postCall(`http://${hostA}/v1/alt`, "alt-key");
    check(
      "deployment secrets: net.fetch sends the key to its allowed host and redacts [secret] from echoed body and headers",
      allowedCall.ok === true &&
        apiA.received.some((r) => r.authorization === `Bearer ${ECHO_SECRET}` && r.body === "ping") &&
        apiA.received.some((r) => r.authorization === `Bearer ${ALT_SECRET}`) &&
        allowedCall.echoHeader === "Bearer [secret]" &&
        allowedCall.text.includes('"Bearer [secret]"') &&
        !allowedCall.text.includes(ECHO_SECRET) &&
        !allowedCall.echoHeader.includes(ECHO_SECRET) &&
        altCall.ok === true &&
        !altCall.text.includes(ALT_SECRET),
      JSON.stringify({ allowedCall, altCall }),
    );

    const wrongHost = await postCall(`http://${hostB}/steal`, "echo");
    const deniedPlugin = await fetch(`${host.url}/s/ops/secret-app/try`).then((r) => r.json());
    check(
      "deployment secrets: host allowlist and secret:<name> capability are enforced",
      wrongHost.ok === false &&
        wrongHost.error.includes(`only for ${hostA}`) &&
        apiB.received.length === 0 &&
        /Missing capability secret:echo/.test(deniedPlugin.hasErr) &&
        /needs secret:echo/.test(deniedPlugin.netErr),
      JSON.stringify({ wrongHost, deniedPlugin, apiBReceived: apiB.received }),
    );

    // Daily request cap per plugin (persisted across restarts); secrets without an explicit override get the 500/day default.
    const cap1 = await postCall(`http://${hostA}/c1`, "capped");
    const cap2 = await postCall(`http://${hostA}/c2`, "capped");
    const cap3 = await postCall(`http://${hostA}/c3`, "capped");
    const uncappedDefault = await postCall(`http://${hostA}/c-default`, "echo");
    await host.stop();
    host = await startHost();
    const capAfterRestart = await postCall(`http://${hostA}/c4`, "capped");
    check(
      "deployment secrets: per-plugin daily request cap stops excess calls and persists across space restarts",
      cap1.ok === true &&
        cap2.ok === true &&
        cap3.ok === false &&
        /daily limit \(4\)/.test(cap3.error) &&
        uncappedDefault.ok === true &&
        capAfterRestart.ok === false &&
        /daily limit \(4\)/.test(capAfterRestart.error),
      JSON.stringify({ cap1, cap2, cap3, uncappedDefault, capAfterRestart }),
    );

    if (a && plugin && pluginLog) {
      await plugin(`export const manifest = { id: 'browser-secret-probe', name: 'Probe', permissions: ['secret:echo'] };
export default async (ctx) => { ctx.log('probe-has ' + JSON.stringify(await ctx.call('secrets', 'has', 'echo'))); };`);
      const probe = await pluginLog("browser-secret-probe", "probe-has ").catch(() => "");
      check("deployment secrets: untrusted browser plugins never see server deployment secrets", probe === 'probe-has {"set":false,"hosts":[]}', probe);
      await a.evaluate(() => window.__host.command("uninstall", "browser-secret-probe")).catch(() => {});
    }
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await host?.stop().catch(() => {});
    await apiA.close().catch(() => {});
    await apiB.close().catch(() => {});
    await rm(spaces, { recursive: true, force: true }).catch(() => {});
    await rm(site, { recursive: true, force: true }).catch(() => {});
  }
}
