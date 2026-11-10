// What a signed-in person adds follows them between devices (std/follow,
// src/server/auth/follow.ts). On a site with a server, one person signs in on
// two devices (two browser contexts with the same session). What they add on
// the first, a plugin with its files, an agent, a model for every app, a move
// and their pick of model, shows on the second without anything being done
// there; a plugin from the account says so in Customize; what they remove on
// the second goes from the first. Only those things reach the account: never
// a key. And signed out, nothing is fetched or asked, as before.
import { watchErrors } from "../page-errors.mjs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

const APP = "demos/trip";
const EVERYWHERE = "_everywhere";

const model = (id, name) => `export const manifest = { id: "${id}", name: "${name}", permissions: ["provide:llm"] };
export default (ctx) => {
  ctx.on("llm:providers", (value) => ({ providers: [...value.providers, { id: "${id}", name: "${name}", ready: true }] }));
  ctx.on("llm:complete", (request) => (request.provider === "${id}" ? { text: "${id} answered", stop: "end", model: "scripted", usage: { input: 1, output: 1 } } : undefined));
};`;

const AGENT = `---
id: follow-helper
name: Follow helper
description: Answers what you write to it.
permissions: []
on:
  - message: true
---
You answer in one short line.
`;

const command = (page, name, arg) => page.evaluate(([n, a]) => window.__host.command(n, a), [name, arg]);
const list = (page, app = APP) => command(page, "user:list", { app }).then((l) => (Array.isArray(l) ? l : []), () => []);
/** Syncs with the account until what the device has for the app passes `test`, and gives the last it saw. */
async function until(page, test, app = APP, ms = 20000) {
  let seen = [];
  let status;
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
    status = await command(page, "follow", app).catch((e) => ({ error: String(e) }));
    seen = await list(page, app);
    if (test(seen, status)) return { ok: true, seen, status };
  }
  return { ok: false, seen, status };
}
const open = async (page, address) => {
  await page.goto(address);
  await page.waitForFunction(() => window.__host);
};
/** Everything under a folder, as paths from it. */
const walk = async (dir, at = "") => (await Promise.all((await readdir(join(dir, at), { withFileTypes: true }).catch(() => [])).map((e) => (e.isDirectory() ? walk(dir, join(at, e.name)) : [join(at, e.name)])))).flat();

export default async function ({ check, context, errors }) {
  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "follow-"));
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" });
  const contexts = [];
  const device = async (name) => {
    const own = await browser.newContext();
    contexts.push(own);
    const page = await own.newPage();
    watchErrors(page, errors, `follow ${name}`);
    return { own, page };
  };
  try {
    // Signed out: a person adds a plugin, and nothing of the account's is fetched or run.
    const out = await device("signed out");
    await open(out.page, `${server.url}/${APP}/app.html`);
    await command(out.page, "user:add", { app: APP, url: "/demos/trip/samples/plum.js" });
    await command(out.page, "user:on", { app: APP, id: "plum" });
    await out.page.waitForFunction(() => window.__host.traces.some((e) => e.name === "user-plugin:on" && e.plugin === "plum"), null, { timeout: 10000 }).catch(() => {});
    // Customize too, where signed in it says what follows them: signed out it asks nothing of the account.
    await out.page.click("ui-panel .launch");
    await out.page.waitForSelector('[data-plugin-id="plum"]', { timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const quiet = await out.page.evaluate(async () => ({
      started: window.__host.traces.filter((e) => e.plugin === "follow").map((e) => e.name),
      fetched: (await window.__host.command("fetched")).filter((url) => /kernel-follow|\/auth\//.test(url)),
    }));
    check("follow: signed out, a person's plugin stays on the device and nothing of the account's is fetched or asked, with Customize open too", !quiet.started.length && !quiet.fetched.length && !(await out.page.$('[data-part="account"]')) && (await list(out.page)).some((p) => p.id === "plum" && p.on), JSON.stringify(quiet));

    // Ann signs in on her first device, and adds things.
    const first = await device("first device");
    const cdp = await first.own.newCDPSession(first.page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await first.page.goto(`${server.url}/account/`);
    await first.page.fill('form[data-action="register"] input[name="name"]', "Ann");
    await first.page.click('form[data-action="register"] button[type="submit"]');
    await first.page.waitForSelector(".signed-in", { timeout: 8000 });

    await open(first.page, `${server.url}/${APP}/app.html`);
    const begun = await first.page.waitForFunction(() => window.__host.traces.some((e) => e.name === "follow:synced"), null, { timeout: 15000 }).then(() => true, () => false);
    check("follow: once signed in, a device starts following the account as an app opens", begun);
    await command(first.page, "user:add", { app: APP, url: "/demos/trip/samples/countdown.js" });
    await command(first.page, "user:on", { app: APP, id: "countdown" });
    await command(first.page, "user:add", { app: APP, files: [{ name: "follow-helper.agent.md", data: AGENT }] });
    await command(first.page, "place:move", { app: APP, plugin: "countdown", place: "days", to: { at: "footer", put: "prepend" } });
    for (const [id, name] of [["follow-model-a", "Model A"], ["follow-model-b", "Model B"]]) {
      await command(first.page, "user:add", { app: EVERYWHERE, files: [{ name: `${id}.js`, data: model(id, name) }] });
      await command(first.page, "user:on", { app: EVERYWHERE, id });
    }
    // Her pick of model, where a person writes to one: the chat.
    await open(first.page, `${server.url}/demos/assistant/app.html`);
    const picker = '[data-key^="chat@"] select[data-action="model"]';
    await first.page.waitForFunction((picker) => [...(document.querySelector(picker)?.options ?? [])].some((o) => o.value === "follow-model-b"), picker, { timeout: 15000 }).catch(() => {});
    await first.page.selectOption(picker, "follow-model-b").catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    const sent = await until(first.page, (_l, status) => status?.on && !status.error && !!status.at);
    check("follow: what she added is sent to her account", sent.ok && sent.status.name === "Ann", JSON.stringify(sent.status));

    // Only what follows a person is in the account: files, what is on, moves and the pick. Never a key.
    const kept = await walk(join(spaces, "_accounts", "follow"));
    const index = JSON.parse(await readFile(join(spaces, "_accounts", "follow", kept.find((p) => p.endsWith("index.json")) ?? "none"), "utf8").catch(() => "{}"));
    const keys = Object.keys(index.items ?? {});
    const kinds = [...new Set(keys.map((k) => k.slice(0, k.indexOf(":"))))].sort();
    check(
      "follow: the account keeps her plugins' files, what is on, her moves and her pick of model, and nothing else",
      kinds.join() === "file,llm,move,on" && keys.includes("file:demos/trip/countdown.js") && keys.includes("file:demos/trip/tram.svg") && keys.includes("file:demos/trip/follow-helper.agent.md") && keys.includes("on:demos/trip/countdown") && keys.includes("move:demos/trip|countdown|days") && keys.includes("llm:prefer") && !keys.some((k) => /secret/i.test(k)),
      keys.join(" "),
    );

    // Her second device: the same session, on a browser that has nothing.
    const second = await device("second device");
    await second.own.addCookies(await first.own.cookies());
    await second.page.goto(`${server.url}/account/`);
    await second.page.waitForSelector(".signed-in", { timeout: 8000 });
    // The account page says she is signed in, and the device starts following: what she added comes while she is still there.
    await second.page.waitForFunction(() => window.__host.traces.some((e) => e.name === "follow:synced"), null, { timeout: 15000 }).catch(() => {});
    await open(second.page, `${server.url}/${APP}/app.html`);
    const arrived = await until(second.page, (l) => l.some((p) => p.id === "countdown" && p.on) && l.some((p) => p.id === "follow-helper") && l.filter((p) => p.everywhere && p.on).length === 2);
    check("follow: on her second device the plugin, on as she left it, her agent and her every-app models are there", arrived.ok, JSON.stringify(arrived.seen.map((p) => [p.id, p.on, !!p.everywhere])));
    const moved = await second.page.waitForSelector('footer [data-plugin="countdown"]', { timeout: 15000 }).then(() => true, () => false);
    const image = await second.page.evaluate(() => fetch("/user/demos/trip/tram.svg").then(async (r) => r.ok && (await r.text()).includes("<svg"), () => false));
    check("follow: it draws there without a reload, where she moved it, and the image that came with it is on the device", moved && image, `${await second.page.evaluate(() => document.querySelector('[data-plugin="countdown"]')?.parentElement?.parentElement?.tagName ?? "not drawn")}, image ${image}`);

    await second.page.click("ui-panel .launch");
    const told = await second.page.waitForSelector('[data-from-account="countdown"]', { timeout: 15000 }).then(() => true, () => false);
    const line = await second.page.evaluate(() => document.querySelector('[data-part="account"]')?.textContent.replace(/\s+/g, " ").trim() ?? "");
    check("follow: Customize says she is signed in, that keys stay on each device, and which plugins came from her account", told && /Signed in as Ann/.test(line) && /API keys stay on each device/.test(line), line);

    await open(second.page, `${server.url}/demos/assistant/app.html`);
    const picked = await second.page.waitForFunction((picker) => document.querySelector(picker)?.value === "follow-model-b", picker, { timeout: 15000 }).then(() => true, () => false);
    check("follow: the model she picked is the one picked on her second device", picked, await second.page.evaluate((picker) => document.querySelector(picker)?.value ?? "no picker", picker));

    // In a space, what is hers everywhere follows her too; the app's own plugins there are that space's copy.
    await first.page.goto(`${server.url}/account/`);
    await first.page.fill('form[data-action="make"] input[name="name"]', "home");
    await first.page.click('form[data-action="make"] button[type="submit"]');
    await first.page.waitForSelector('.space-list button:has-text("Invite someone")', { timeout: 8000 }).catch(() => {});
    await open(second.page, `${server.url}/s/home/${APP}/`);
    const inSpace = await until(second.page, (l) => l.filter((p) => p.everywhere && p.on).length === 2);
    check("follow: in a space her every-app models are there and on, and the app's plugins stay that space's own", inSpace.ok && !inSpace.seen.some((p) => p.id === "countdown"), JSON.stringify(inSpace.seen.map((p) => [p.id, p.on, !!p.everywhere])));
    await open(second.page, `${server.url}/${APP}/app.html`);

    // Removed on the second, it goes from the first, with the app open there.
    await open(first.page, `${server.url}/${APP}/app.html`);
    await first.page.waitForSelector('footer [data-plugin="countdown"]', { timeout: 15000 }).catch(() => {});
    await command(second.page, "user:remove", { app: APP, id: "countdown" });
    await until(second.page, (l, status) => !l.some((p) => p.id === "countdown") && !status?.error, APP, 5000);
    const gone = await until(first.page, (l) => !l.some((p) => p.id === "countdown"));
    const undrawn = await first.page.waitForSelector('[data-plugin="countdown"]', { state: "detached", timeout: 15000 }).then(() => true, () => false);
    check("follow: a plugin removed on one device goes from the other, and from the page open there", gone.ok && undrawn && gone.seen.some((p) => p.id === "follow-helper"), JSON.stringify(gone.seen.map((p) => p.id)));

    // Signed out again, the device keeps what it has and stops asking.
    await first.page.evaluate(() => fetch("/auth/signout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    const after = await command(first.page, "follow", APP);
    const still = await list(first.page);
    check("follow: signed out, the device keeps what it has and no longer follows the account", after?.on === false && still.some((p) => p.id === "follow-helper"), JSON.stringify(after));
  } finally {
    for (const own of contexts) await own.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true }).catch(() => {});
  }
}
