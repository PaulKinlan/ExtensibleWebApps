// End-to-end checks for the platform. Builds are served with
// `vite preview`; Chromium (Playwright) drives two tabs against one shared
// worker kernel, then a third with the dedicated-worker fallback.
//
//   npm test            build, run, print the measurements
//
// Exits non-zero if any check fails.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PORT = 4173;
const URL = `http://localhost:${PORT}/`;
const results = [];
const measurements = {};

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const server = spawn(process.execPath, [fileURLToPath(new globalThis.URL("../node_modules/vite/bin/vite.js", import.meta.url)), "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && resolve());
  server.on("exit", (code) => reject(new Error(`vite preview exited with ${code}`)));
  setTimeout(resolve, 5000);
});

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext();
const errors = [];

async function openTab(url = URL) {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__host);
  return page;
}

const traceHas = (page, fn) => page.evaluate(`window.__host.traces.some(${fn})`);
const status = (page) => page.textContent("footer");

try {
  // ---- One tab ----
  const a = await openTab();
  await a.waitForFunction(() => window.__host.traces.filter((e) => e.name === "plugin:ready").length >= 10, null, { timeout: 10000 });
  check("all ten sandboxed plugins start in their own workers", (await a.evaluate(() => window.__host.workers.size)) === 10);

  // Manifests are read before any code runs.
  const refused = await a.evaluate(() => window.__host.command("install", "export const manifest = { id: 'bad', name: 'Bad', permissions: ['ui'].concat(['network']) };\nexport default () => {};"));
  check("a manifest that isn't a plain literal is refused before running", refused.ok === false && /plain literal/.test(refused.error), refused.error);
  const decoy = await a.evaluate(() => window.__host.command("install", "// export const manifest = { id: 'decoy', name: 'Decoy', permissions: [] };\nconst x = 1;\nexport const manifest = Object.assign({}, { id: 'decoy', name: 'Decoy', permissions: [] });\nexport default () => {};"));
  check("a manifest in a comment can't stand in for the real one", decoy.ok === false && /must start with/.test(decoy.error), decoy.error);
  const suffix = await a.evaluate(() => window.__host.command("install", "export const manifest = { id: 'suffix', name: 'Suffix', permissions: [] }.valueOf();\nexport default () => {};"));
  check("anything after the manifest literal is refused", suffix.ok === false && /after the manifest/.test(suffix.error), suffix.error);
  const liar = await a.evaluate(() => window.__host.command("install", "export const manifest = { id: 'liar', name: 'Liar', permissions: [] };\nmanifest.permissions.push('audio');\nexport default () => {};"));
  await a.waitForFunction(() => window.__host.traces.some((e) => e.name === "plugin:manifest-changed" && e.plugin === "liar"), null, { timeout: 3000 }).catch(() => {});
  check("a plugin whose manifest changes when it runs is stopped", liar.ok && !liar.started && (await traceHas(a, `(e) => e.name === "plugin:manifest-changed" && e.plugin === "liar"`)), JSON.stringify(liar));
  // `late` also has a button whose handler makes a call before and after an await.
  const lateSource = `export const manifest = { id: 'late', name: 'Late', permissions: ['ui'], settings: { "mode:loud": { type: "boolean", title: "Loud" } } };
export default (ctx) => {
  ctx.ui.render('statusbar', 'late', { type: 'stack', direction: 'row', children: [{ type: 'text', text: 'late plugin here' }, { type: 'button', label: 'Ping twice', action: 'ping' }] });
  ctx.ui.onEvent(async () => {
    const here = ctx.traced();
    await here.call('kernel', 'ping');
    await here.call('kernel', 'ping');
  });
};`;
  const installed = await a.evaluate((source) => window.__host.command("install", source), lateSource);
  await a.waitForSelector("footer >> text=late plugin here");
  check("a plugin installed at run time starts and renders", installed.ok && installed.started);
  const reserved = await a.evaluate(() => window.__host.command("install", "export const manifest = { id: 'plugins', name: 'Fake panel', permissions: ['ui'] };\nexport default () => {};"));
  check("a plugin can't take an id the kernel uses for its own views", reserved.ok === false && /reserved/.test(reserved.error), reserved.error);

  // The plugins panel: where each plugin came from, on and off, remove.
  const panel = (id) => `aside [data-key="plugins:${id}"]`;
  await a.waitForSelector(`${panel("late")} >> text=with the data`);
  check("the plugins panel shows built-in plugins and ones kept with the data", (await a.textContent(panel("tone"))).includes("built in"));
  const workers = () => a.evaluate(() => window.__host.workers.size);
  const before = await workers();
  await a.click(`${panel("sneaky")} >> text=Turn off`);
  await a.waitForFunction((n) => window.__host.workers.size === n - 1, before, { timeout: 5000 });
  await a.click(`${panel("sneaky")} >> text=Turn on`);
  await a.waitForFunction((n) => window.__host.workers.size === n, before, { timeout: 5000 });
  check("turning a plugin off stops its worker, and on starts it again", true, `${before} → ${before - 1} → ${before} workers`);
  await a.evaluate(() => window.__host.command("install", "export const manifest = { id: 'temp', name: 'Temporary', permissions: [] };\nexport default () => {};"));
  await a.waitForFunction((n) => window.__host.workers.size === n + 1, before, { timeout: 5000 });
  await a.click(`${panel("temp")} >> text=Remove`);
  await a.waitForFunction((n) => window.__host.workers.size === n, before, { timeout: 5000 });
  check("removing a plugin kept with the data stops it and takes it off the panel", !(await a.$(panel("temp"))));
  check("built-in plugins can't be removed", !(await a.$(`${panel("tone")} >> text=Remove`)));

  // Self-description: the kernel prints its own API reference.
  const reference = await a.evaluate(() => window.__host.command("reference"));
  const onDisk = readFileSync(new globalThis.URL("../docs/api.md", import.meta.url), "utf8");
  check("docs/api.md is what the kernel prints about itself", reference.markdown === onDisk, reference.markdown === onDisk ? "" : "run npm run reference");
  const hookNames = await a.evaluate(() => window.__host.command("reference").then((r) => r.data.hooks.map((h) => h.name)));
  check("the reference lists every hook and service the kernel has", ["data:changed", "data:beforeWrite", "note:open"].every((h) => hookNames.includes(h)) && ["audio", "store", "files", "storage", "kernel", "settings", "data"].every((s) => reference.data.services.some((x) => x.name === s)));
  const wordCount = reference.data.plugins.find((p) => p.id === "word-count");
  check("the live reference says which hooks each running plugin listens to", wordCount?.hooks.includes("note:open") && /## Installed now/.test(reference.live), wordCount?.hooks.join(" "));
  await a.evaluate(() => window.__host.command("install", `export const manifest = { id: 'reader', name: 'Reader', permissions: ['ui'] };
export default async (ctx) => {
  const ref = await ctx.call('kernel', 'reference');
  const refused = [];
  for (const method of ['nope', 'toString', '__proto__']) {
    try { await ctx.call('kernel', method); refused.push('allowed'); } catch (error) { refused.push(error.message); }
  }
  for (const service of ['toString', '__proto__']) {
    try { await ctx.call(service, 'ping'); refused.push('allowed'); } catch (error) { refused.push(error.message); }
  }
  ctx.ui.render('devtools', 'reader', { type: 'text', text: 'reader sees ' + ref.services.length + ' services' });
  ctx.log('reader: ' + JSON.stringify(refused));
};`));
  await a.waitForSelector('#devtools [data-slot="devtools"] >> text=reader sees 7 services', { timeout: 5000 });
  check("a plugin can read the reference, and draw in the devtools slot", true);
  await a.waitForFunction(() => window.__host.traces.some((e) => e.plugin === "reader" && e.detail?.startsWith("reader:")), null, { timeout: 5000 });
  const refusedCalls = await a.evaluate(() => JSON.parse(window.__host.traces.find((e) => e.plugin === "reader" && e.detail?.startsWith("reader:")).detail.slice(8)));
  check("a method or service the reference doesn't list can't be called", refusedCalls.length === 5 && refusedCalls.slice(0, 3).every((m) => /is not a method/.test(m)) && refusedCalls.slice(3).every((m) => /No service named/.test(m)), refusedCalls.join("; "));
  await a.evaluate(() => window.__host.command("uninstall", "reader"));
  await a.waitForFunction((n) => window.__host.workers.size === n, before, { timeout: 5000 });

  // HTML views: plain HTML, sanitised, updated in place.
  await a.evaluate(() => window.__host.command("install", `export const manifest = { id: 'htmlcheck', name: 'HTML check', permissions: ['ui'] };
export default (ctx) => {
  let n = 0;
  const draw = () => ctx.ui.render('devtools', 'form', ctx.ui.html\`
    <form data-action="save"><label>Name <input name="name" value="Ada"></label><label><input type="checkbox" name="ok" checked> OK</label><input type="number" name="count" value="3"><input name="__proto__" value="p"><select multiple name="pick"><option value="a" selected>a</option><option value="b" selected>b</option><option value="c">c</option></select><button type="submit">Save</button></form>
    <ui-badge id="lbl">Label</ui-badge><input name="a11y" aria-labelledby="lbl"><a href="#lbl" data-test="frag">jump</a><div hidden data-test="hid"><ui-stack>hidden</ui-stack></div>
    <p data-test="evil">safe<script>window.__pwned = 1</script><img src="https://example.com/x.png" onerror="window.__pwned = 2"><a href="javascript:window.__pwned = 3">bad link</a><iframe src="https://example.com"></iframe><blink>kept text</blink></p>
    <p data-test="escaped">\${'<b>not bold</b>'}</p>
    <input data-action="typed" data-live name="live" value="">
    <ui-stat label="Ticks" value="\${n}"></ui-stat>\`);
  draw();
  setInterval(() => { n++; draw(); }, 100);
  ctx.ui.onEvent((action, value) => ctx.log('html-event ' + action + ' ' + JSON.stringify(value)));
};`));
  const view = '#devtools [data-key="htmlcheck:form"]';
  await a.waitForSelector(`${view} >> text=kept text`, { timeout: 5000 });
  const cleaned = await a.evaluate((sel) => {
    const el = document.querySelector(sel);
    const all = [...el.querySelectorAll("*")];
    return {
      script: !!el.querySelector("script, iframe, blink"),
      handlers: all.some((x) => [...x.attributes].some((at) => at.name.startsWith("on"))),
      remoteImage: [...el.querySelectorAll("img")].some((img) => img.hasAttribute("src")),
      jsLink: [...el.querySelectorAll("a")].some((x) => /^javascript:/i.test(x.getAttribute("href") ?? "")),
      pwned: window.__pwned,
      escaped: el.querySelector('[data-test="escaped"]').textContent,
      bold: !!el.querySelector('[data-test="escaped"] b'),
    };
  }, view);
  check("HTML views keep no script, frames, event attributes, javascript: links or remote images", !cleaned.script && !cleaned.handlers && !cleaned.remoteImage && !cleaned.jsLink && cleaned.pwned === undefined, JSON.stringify(cleaned));
  check("ctx.ui.html escapes values", cleaned.escaped === "<b>not bold</b>" && !cleaned.bold, cleaned.escaped);
  const htmlEvent = (prefix) => a.waitForFunction((p) => window.__host.traces.find((e) => e.plugin === "htmlcheck" && e.detail?.startsWith(p)), prefix, { timeout: 5000 }).then((h) => h.jsonValue()).then((e) => e.detail);
  await a.fill(`${view} input[name="name"]`, "Grace");
  await a.focus(`${view} input[name="count"]`);
  await a.waitForTimeout(400);
  await a.click(`${view} >> text=Save`);
  const saved = await htmlEvent("html-event save");
  check("a form with data-action sends every named field, typed, with edits kept across redraws after focus moves", saved === 'html-event save {"name":"Grace","ok":true,"count":3,"__proto__":"p","pick":["a","b"]}', saved);
  const refs = await a.evaluate((sel) => {
    const el = document.querySelector(sel);
    const badge = el.querySelector("ui-badge[id]");
    return { id: badge.id, labelledby: el.querySelector('input[name="a11y"]').getAttribute("aria-labelledby"), href: el.querySelector('[data-test="frag"]').getAttribute("href"), hidden: getComputedStyle(el.querySelector('[data-test="hid"]')).display };
  }, view);
  check("ARIA id references and fragment links are scoped like ids, and hidden hides", refs.labelledby === refs.id && refs.href === "#" + refs.id && refs.id !== "lbl" && refs.hidden === "none", JSON.stringify(refs));
  await a.focus(`${view} input[name="live"]`);
  await a.keyboard.type("hello", { delay: 60 });
  await a.waitForTimeout(500);
  const kept = await a.evaluate((sel) => ({ focused: document.activeElement?.getAttribute("name"), value: document.querySelector(`${sel} input[name="live"]`).value, ticks: document.querySelector(`${sel} ui-stat`).getAttribute("value") }), view);
  const typed = await htmlEvent('html-event typed "hello"');
  check("typing and focus survive a view redrawn every 100 ms", kept.focused === "live" && kept.value === "hello" && Number(kept.ticks) > 5 && !!typed, JSON.stringify(kept));
  await a.evaluate(() => window.__host.command("uninstall", "htmlcheck"));
  await a.waitForFunction((n) => window.__host.workers.size === n, before, { timeout: 5000 });

  // Collections: a plugin owns a typed collection; views bind to it; others need capabilities.
  const plugin = (src) => a.evaluate((source) => window.__host.command("install", source), src);
  const pluginLog = (id, prefix) => a.waitForFunction(([i, p]) => window.__host.traces.findLast((e) => e.plugin === i && e.detail?.startsWith(p)), [id, prefix], { timeout: 5000 }).then((h) => h.jsonValue()).then((e) => e.detail);
  await plugin(`export const manifest = { id: 'books', name: 'Books', permissions: ['ui'], collections: { books: { title: 'Books', schema: { type: 'object', required: ['title'], properties: {
  title: { type: 'string', title: 'Title' }, author: { type: 'string' }, year: { type: 'integer', minimum: 1450 }, shelf: { type: 'string', enum: ['to read', 'reading', 'done'] } } } } } };
export default (ctx) => {
  ctx.ui.render('app.main', 'books', '<h2>Books</h2><ui-form collection="books" fields="title,author,year" action="added"></ui-form><ui-table collection="books" columns="title,author,year" sort="title" row-action="open" deletable></ui-table>');
  ctx.ui.onEvent((action, value) => ctx.log('books-event ' + action + ' ' + JSON.stringify(value)));
};`);
  const books = 'main [data-key="books:books"]';
  const reviewCard = 'main [data-key^="review:"]';
  await a.waitForSelector(`${books} ui-form input[name="title"]`, { timeout: 5000 });
  await a.click(`${books} ui-form button[type="submit"]`);
  await a.waitForSelector(`${books} ui-form >> text=Title is required`, { timeout: 5000 });
  await a.fill(`${books} ui-form input[name="title"]`, "Dune");
  await a.fill(`${books} ui-form input[name="year"]`, "1200");
  await a.click(`${books} ui-form button[type="submit"]`);
  await a.waitForSelector(`${books} ui-form >> text=year must be at least 1450`, { timeout: 5000 });
  check("a bound form checks records against the collection's schema", true);
  await a.fill(`${books} ui-form input[name="year"]`, "1965");
  await a.fill(`${books} ui-form input[name="author"]`, "Frank Herbert");
  await a.click(`${books} ui-form button[type="submit"]`);
  await a.waitForSelector(`${books} ui-table >> text=Frank Herbert`, { timeout: 5000 });
  const added = await pluginLog("books", "books-event added");
  check("saving a bound form adds the record and the bound table updates", /^books-event added "\w+"$/.test(added), added);
  const cleared = await a.evaluate((sel) => document.querySelector(sel).querySelector("ui-form").shadowRoot.querySelector('input[name="title"]').value, books);
  check("after adding a record the bound form starts a fresh one", cleared === "", cleared);
  // A plugin that declares a collection someone else owns doesn't own it, and can't intercept its writes.
  await plugin(`export const manifest = { id: 'squatter', name: 'Squatter', permissions: ['data:read:books'], collections: { books: { schema: { type: 'object' } } } };
export default (ctx) => {
  ctx.on('data:beforeWrite:books', () => ({ block: 'mine now' }));
  ctx.call('data', 'put', 'books', JSON.parse('{"__proto__": {"title": "Smuggled"}}')).then((r) => ctx.log('squatter ' + JSON.stringify(r)), (e) => ctx.log('squatter refused: ' + e.message));
};`);
  const squatted = await pluginLog("squatter", "squatter");
  const squatDenied = await a.waitForFunction(() => window.__host.traces.some((e) => e.kind === "denied" && e.plugin === "squatter" && e.name === "hook:intercept:data:beforeWrite:books"), null, { timeout: 5000 }).then(() => true, () => false);
  check("declaring another plugin's collection grants neither writes nor interception", squatted === "squatter refused: Missing capability data:write:books" && squatDenied, squatted);
  await plugin(`export const manifest = { id: 'shelf', name: 'Shelf', permissions: ['data:read:books', 'hook:listen:data:changed:books'] };
export default (ctx) => {
  ctx.on('data:changed:books', async function () { const all = await this.call('data', 'list', 'books'); this.log('shelf sees ' + all.length); });
  ctx.call('data', 'list', 'books').then((all) => ctx.log('shelf sees ' + all.length));
};`);
  check("a second plugin with data:read reads another plugin's collection", (await pluginLog("shelf", "shelf sees")) === "shelf sees 1");
  await plugin(`export const manifest = { id: 'nosy', name: 'Nosy', permissions: ['hook:listen:data:changed:books'] };
export default (ctx) => {
  ctx.on('data:changed:books', () => ctx.log('nosy heard'));
  ctx.call('data', 'list', 'books').then(() => ctx.log('nosy read it'), (e) => ctx.log('nosy refused: ' + e.message));
};`);
  const nosy = await pluginLog("nosy", "nosy");
  const nosyDenied = await a.evaluate(() => window.__host.traces.some((e) => e.kind === "denied" && e.plugin === "nosy" && e.name === "data:read:books"));
  check("without data:read a plugin can neither read a collection nor hear its changes", nosy === "nosy refused: Missing capability data:read:books" && nosyDenied, nosy);
  await plugin(`export const manifest = { id: 'lender', name: 'Lender', permissions: ['data:write:books'] };
export default async (ctx) => {
  const smuggled = await ctx.call('data', 'put', 'books', JSON.parse('{"__proto__": {"title": "Smuggled"}}'));
  ctx.log('lender-proto ' + JSON.stringify(smuggled));
  const result = await ctx.call('data', 'put', 'books', { title: 'Lent book', author: 'A. Friend' }, 'Record a book you lent');
  ctx.log('lender ' + JSON.stringify(result));
};`);
  await a.waitForSelector(`${reviewCard} >> text=Lender wants to change a new record in Books`, { timeout: 5000 });
  await a.click(`${reviewCard} >> text=Accept`);
  await a.waitForSelector(`${books} ui-table >> text=Lent book`, { timeout: 5000 });
  check("another plugin's write to a collection is reviewed first", /"ok":true/.test(await pluginLog("lender", "lender")));
  const proto = await pluginLog("lender", "lender-proto");
  check("a field named __proto__ can't satisfy a required field", /"ok":false/.test(proto) && /Title is required/.test(proto), proto);
  check("data:changed:<collection> reaches plugins that may read it", (await pluginLog("shelf", "shelf sees 2")) === "shelf sees 2" && !(await a.evaluate(() => window.__host.traces.some((e) => e.plugin === "nosy" && e.detail === "nosy heard"))));
  await a.click(`${books} ui-table button.link >> text=Dune`);
  check("a bound table's row sends its row-action with the record id", /^books-event open "\w+"$/.test(await pluginLog("books", "books-event open")));
  await a.click(`${books} ui-table button[aria-label="Delete Dune"]`);
  await a.waitForFunction((sel) => !document.querySelector(sel).querySelector("ui-table").shadowRoot.textContent.includes("Dune"), books, { timeout: 5000 });
  check("a deletable table deletes a record", (await pluginLog("shelf", "shelf sees 1")) === "shelf sees 1");
  for (const id of ["books", "shelf", "nosy", "lender", "squatter"]) await a.evaluate((i) => window.__host.command("uninstall", i), id);
  await a.waitForFunction((n) => window.__host.workers.size === n, before, { timeout: 5000 });

  // Worker content security policy.
  await a.waitForFunction(() => window.__host.traces.filter((e) => e.detail?.startsWith("network:")).length >= 2, null, { timeout: 5000 });
  const net = await a.evaluate(() => Object.fromEntries(window.__host.traces.filter((e) => e.detail?.startsWith("network:")).map((e) => [e.plugin, e.detail])));
  check("a plugin with the network permission can fetch", /status 200/.test(net.fetcher ?? ""), net.fetcher);
  check("a plugin without it is blocked by its worker's CSP", /refused/.test(net.offline ?? ""), net.offline);
  // offline also tries to start a network-enabled worker of its own.
  await a.waitForFunction(() => window.__host.traces.some((e) => e.plugin === "offline" && e.detail?.startsWith("escape:")), null, { timeout: 5000 }).catch(() => {});
  const escape = await a.evaluate(() => window.__host.traces.filter((e) => e.plugin === "offline" && e.detail?.startsWith("escape:")).map((e) => e.detail).join(", "));
  check("a plugin can't start a worker of its own", /blocked/.test(escape), escape);
  check("the kernel runs in a shared worker", (await a.textContent("#mode")).includes("shared worker"));

  // Editor extensions, unchanged, through the shim.
  await a.click("nav >> text=Welcome");
  await a.waitForFunction(() => document.querySelector("footer").textContent.includes("words"));
  check("editor's word-count.js runs unchanged and fills the status bar", /\d+ words · \d+ min read/.test(await status(a)), await status(a));

  await a.fill("textarea", "Hello there\n\nOne two three four five six seven eight nine ten.");
  await a.waitForFunction(() => document.querySelector("footer").textContent.includes("12 words"));
  check("edits reach plugin workers after the debounce", (await status(a)).includes("12 words"));
  check("editor's edit-times.js runs unchanged", (await status(a)).includes("Edited just now"), await status(a));

  await a.click("main button >> text=Save");
  await a.waitForSelector("main >> text=Saved");
  check("a save passes the intercepting plugin", true);

  // Interception: a plugin in a worker blocks a write through a serial hook.
  await a.fill("textarea", "THIS IS ALL CAPITALS AND SHOULD NOT SAVE");
  await a.waitForTimeout(400);
  await a.click("main button >> text=Save");
  await a.waitForSelector("text=Not saved: the note is all capitals");
  check("no-shouting.js blocks the write from its worker", true);

  // The gate.
  check("the gate refuses a hook the manifest doesn't grant", await traceHas(a, `(e) => e.kind === "denied" && e.plugin === "sneaky" && e.name === "hook:intercept:data:beforeWrite"`));
  check("the gate refuses a service the manifest doesn't grant", await traceHas(a, `(e) => e.kind === "denied" && e.plugin === "sneaky" && e.name === "audio"`));

  // Audio: DSP in an AudioWorklet, registered by a plugin in a worker.
  // Settings: a form built from the manifest; the plugin hears the change.
  await a.fill(`${panel("tone")} input[name=frequency]`, "880");
  await a.press(`${panel("tone")} input[name=frequency]`, "Tab");
  await a.waitForSelector("text=Play 880 Hz", { timeout: 5000 });
  check("a settings form built from the manifest reaches the plugin", true);
  await a.selectOption(`${panel("tone")} select[name=wave]`, "square");
  await a.waitForFunction(() => window.__host.traces.some((e) => e.name === "settings:changed" && e.detail === 'wave = "square"'));
  check("a select field takes its options from the manifest's enum", (await a.$$eval(`${panel("tone")} select[name=wave] option`, (o) => o.map((x) => x.value))).join() === "sine,square");
  check("focus stays on the field after the panel redraws", await a.evaluate(() => document.activeElement?.getAttribute("name") === "wave"));
  await a.check(`${panel("late")} input[name="mode:loud"]`);
  await a.waitForFunction(() => window.__host.traces.some((e) => e.plugin === "late" && e.name === "settings:changed" && e.detail === "mode:loud = true"), null, { timeout: 5000 }).catch(() => {});
  const colon = await a.evaluate(() => window.__host.traces.filter((e) => e.plugin === "late" && e.name.startsWith("settings:")).map((e) => `${e.name} ${e.detail}`).join("; "));
  check("a setting whose key has a colon saves", /settings:changed mode:loud = true/.test(colon), colon);

  await a.click("text=Play 880 Hz");
  await a.waitForFunction(() => window.__host.audioStats.played > 0, null, { timeout: 5000 });
  check("tone.js plays through an AudioWorklet", true, `context ${await a.evaluate(() => window.__host.audioStats.state)}`);
  await a.waitForFunction(() => window.__host.traces.some((e) => e.plugin === "tone" && e.detail === "played 1"), null, { timeout: 5000 });
  const played = await a.evaluate(() => {
    const log = window.__host.traces.find((e) => e.plugin === "tone" && e.detail === "played 1");
    return { trace: log.trace, with: window.__host.traces.filter((e) => log.trace && e.trace === log.trace).map((e) => `${e.kind}:${e.name}`) };
  });
  check("a plugin's log after an await keeps the trace of the click it handles", Boolean(played.trace) && played.with.some((x) => x.startsWith("bridge:")), `#${played.trace}: ${played.with.join(", ")}`);
  await a.click("text=Ping twice");
  await a.waitForFunction(() => window.__host.traces.filter((e) => e.plugin === "late" && e.name === "kernel.ping").length >= 2, null, { timeout: 5000 });
  const pings = await a.evaluate(() => window.__host.traces.filter((e) => e.plugin === "late" && e.name === "kernel.ping").map((e) => e.trace));
  check("a plugin's service call after an await keeps the trace of the click it handles", pings.length === 2 && Boolean(pings[0]) && pings[0] === pings[1], pings.join(", "));

  // Drawing: an OffscreenCanvas animated in the plugin's worker.
  await a.waitForFunction(() => window.__host.traces.some((e) => e.plugin?.startsWith("bars@") && /frames drawn: [1-9]/.test(e.detail ?? "")), null, { timeout: 5000 });
  const frames = await a.evaluate(() => window.__host.traces.filter((e) => e.plugin?.startsWith("bars@") && e.detail?.startsWith("frames")).at(-1).detail);
  check("bars.js (scope: tab) draws on an OffscreenCanvas in its worker", true, frames);

  // Observability: one save followed across awaits and workers by its trace id.
  const saveTrace = await a.evaluate(() => {
    const blocked = window.__host.traces.find((e) => e.kind === "remote" && e.plugin === "no-shouting" && e.detail?.includes("all capitals"));
    return blocked ? window.__host.traces.filter((e) => e.trace === blocked.trace).map((e) => `${e.kind}:${e.name}`) : [];
  });
  check("a trace id links the click, the kernel dispatch and the plugin's answer", saveTrace.includes("dispatch:data:beforeWrite") && saveTrace.includes("remote:data:beforeWrite"), saveTrace.join(", "));
  await a.fill("textarea", "Hello there\n\nOne two three four five six seven eight nine ten.");
  await a.waitForTimeout(400);
  await a.click("main button >> text=Save");
  await a.waitForSelector("main >> text=Saved");
  await a.waitForTimeout(300);
  const afterAwait = await a.evaluate(() => {
    const changed = window.__host.traces.filter((e) => e.kind === "dispatch" && e.name === "data:changed" && e.trace).at(-1);
    return changed ? window.__host.traces.filter((e) => e.trace === changed.trace).map((e) => `${e.kind}:${e.name}`) : [];
  });
  check("the trace id survives the awaits between a write's check and its change event", afterAwait.includes("dispatch:data:beforeWrite") && afterAwait.includes("dispatch:data:changed") && afterAwait.includes("dispatch:note:save"), afterAwait.join(", "));

  // Change review: a plugin's write outside its own data shows a diff first.
  const messy = "Hello there   \n\n\n\nOne two three four five six seven eight nine ten.";
  const tidied = "Hello there\n\nOne two three four five six seven eight nine ten.";
  const card = 'main [data-key^="review:"]';
  const textarea = () => a.inputValue("textarea");
  const saveText = async (text) => {
    await a.fill("textarea", text);
    await a.waitForTimeout(400);
    await a.click("main button >> text=Save");
    await a.waitForSelector("main >> text=Saved");
  };
  await saveText(messy);
  await a.click("text=Tidy this note");
  await a.waitForSelector(card);
  const shown = await a.$eval(card, (el) => ({ text: el.textContent, del: el.querySelectorAll("pre.diff .del").length, add: el.querySelectorAll("pre.diff .add").length }));
  check("a plugin's write to a note shows the person a diff and a reason first", shown.text.includes("Tidy wants to change") && shown.text.includes("Reason: Trim trailing spaces") && shown.del > 0 && shown.add > 0, `${shown.del} removed, ${shown.add} added`);
  check("nothing changes while the review is open", (await textarea()) === messy);
  await a.click(`${card} >> text=Decline`);
  await a.waitForSelector("aside >> text=The person declined the change");
  check("declining leaves the note as it was", (await textarea()) === messy && !(await a.$(card)));
  await a.click("text=Tidy this note");
  await a.waitForSelector(card);
  await a.click(`${card} >> text=Accept`);
  await a.waitForFunction((t) => document.querySelector("textarea").value === t, tidied, { timeout: 5000 });
  check("accepting applies the change, and the notes app shows it", (await a.textContent("main")).includes("Changed by a plugin"));

  // The person saves new edits while a review is open: accepting the old proposal must not overwrite them.
  await saveText(messy);
  await a.click("text=Tidy this note");
  await a.waitForSelector(card);
  const mine = `${messy}\nMy newer line.`;
  await saveText(mine);
  await a.click(`${card} >> text=Accept`);
  await a.waitForSelector("aside >> text=the note changed while the review was open");
  check("accepting a review after the note changed doesn't overwrite the newer text", (await textarea()) === mine);

  await saveText(messy);
  await a.click("text=Tidy this note");
  await a.waitForSelector(card);
  await a.click(`${card} >> text=Always allow in notes`);
  await a.waitForFunction((t) => document.querySelector("textarea").value === t, tidied, { timeout: 5000 });
  await saveText(messy);
  const asked = await a.evaluate(() => window.__host.traces.filter((e) => e.name === "review:asked").length);
  await a.click("text=Tidy this note");
  await a.waitForFunction((t) => document.querySelector("textarea").value === t, tidied, { timeout: 5000 });
  const askedAfter = await a.evaluate(() => window.__host.traces.filter((e) => e.name === "review:asked").length);
  check("“always allow” is remembered, so the next change goes through without asking", askedAfter === asked && !(await a.$(card)));
  await a.waitForSelector('aside [data-key="plugins:tidy"] >> text=Changes notes without asking');
  await a.click('aside [data-key="plugins:tidy"] >> text=Forget');
  await a.waitForFunction(() => !document.querySelector('aside [data-key="plugins:tidy"]').textContent.includes("without asking"));
  check("the plugins panel lists the grant, and forgetting it takes it away", true);

  await a.click("text=Export as Markdown");
  await a.waitForSelector(`${card} >> text=exports/hello-there.md`);
  await a.click(`${card} >> text=Accept`);
  await a.waitForSelector("aside >> text=Exported to exports/hello-there.md");
  const exported = await a.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const file = await (await (await root.getDirectoryHandle("exports")).getFileHandle("hello-there.md")).getFile();
    return file.text();
  });
  check("a reviewed file write lands in the data folder", exported === tidied);
  check("a plugin's own storage needs no review", (await a.textContent('aside [data-key="tidy:tidy"]')).includes("Tidied 3 · exported 1"));

  // Path checks: sneaky may write files anywhere (files:*) but not into the platform's folders, outside the data folder, or hidden files.
  const refusedPaths = await a.evaluate(() => window.__host.traces.filter((e) => e.kind === "denied" && e.name === "files:path" && e.plugin === "sneaky").map((e) => e.detail));
  const evil = await a.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await (await root.getDirectoryHandle("plugins")).getFileHandle("evil.js");
      return true;
    } catch {
      return false;
    }
  });
  // sneaky tries once each time it starts, and the panel test turned it off and on again.
  const distinct = [...new Set(refusedPaths)];
  check("path checks refuse platform folders, .. and hidden files, whatever the capability", distinct.length === 3 && !evil, distinct.join("; "));

  const changes = await a.evaluate(() => window.__host.command("changes"));
  const kinds = changes.map((c) => `${c.kind}${c.outcome ? `:${c.outcome}` : ""}`);
  check(
    "the change log records installs, settings, grants and every reviewed write",
    ["install", "settings", "write:rejected", "write:allowed-once", "grant", "write:allowed-always", "write:granted", "revoke"].every((k) => kinds.includes(k)),
    [...new Set(kinds)].join(", "),
  );

  // Measurements.
  const bench = await a.evaluate(() => window.__host.command("bench", 500));
  measurements.hookRoundTrip = bench;
  check("hook round trip to a plugin worker: p95 under 2 ms", bench.remote.p95 < 2, `p50 ${bench.remote.p50} ms, p95 ${bench.remote.p95} ms, in-kernel p50 ${bench.local.p50} ms`);

  const reload = await a.evaluate(() => window.__host.command("reload-test", 100));
  measurements.reload = reload;
  check(
    "100 reloads leave no listeners or workers behind",
    reload.failures === 0 && reload.before.hooks === reload.after.hooks && reload.before.workers === reload.after.workers,
    `listeners ${reload.before.hooks} → ${reload.after.hooks}, workers ${reload.before.workers} → ${reload.after.workers}, ${reload.failures} failed`,
  );

  // ---- Two tabs, one kernel ----
  const b = await openTab();
  await b.waitForSelector("nav >> text=Hello there");
  check("a second tab shares the kernel and sees the same notes", true);
  await b.waitForFunction(() => window.__host.workers.size === 1, null, { timeout: 5000 });
  check("the second tab runs only its own tab-scoped plugin", [...(await b.evaluate(() => [...window.__host.workers.keys()]))].every((k) => k.startsWith("bars@")) && !(await b.evaluate(() => window.__host.spawner)));
  await b.waitForFunction((t) => window.__host.traces.some((e) => e.plugin === `bars@${t}` && /frames drawn: [1-9]/.test(e.detail ?? "")), await b.evaluate(() => window.__host.tab), { timeout: 5000 });
  check("a tab-scoped plugin draws in the second tab too", true);
  check("plugin views appear in the second tab", (await b.textContent("aside")).includes("Tone"));

  // Hand over: close the spawner tab; the second tab starts the plugins again.
  await a.close({ runBeforeUnload: true });
  await b.waitForFunction(() => window.__host.spawner && window.__host.workers.size === 11, null, { timeout: 10000 });
  check("closing the spawner tab moves the plugin workers to the other tab", true);
  await b.click("nav >> text=Hello there");
  await b.waitForFunction(() => /\d+ words/.test(document.querySelector("footer").textContent), null, { timeout: 5000 });
  check("plugins work again after the handover", true, await status(b));

  // A second kernel on the same data folder loads what the first one kept there.
  const d = await openTab(`${URL}?kernel=dedicated`);
  await d.waitForSelector("footer >> text=late plugin here", { timeout: 10000 });
  await d.waitForSelector("text=Play 880 Hz", { timeout: 5000 });
  const dPlugins = await d.$$eval('aside [data-key^="plugins:"]', (els) => els.map((e) => e.dataset.key.slice(8)));
  await d.waitForSelector('aside [data-key="tidy:tidy"] >> text=Tidied 3 · exported 1', { timeout: 5000 }).catch(() => {});
  check("a plugin's own storage is still there in a new kernel", (await d.textContent('aside [data-key="tidy:tidy"]')).includes("Tidied 3 · exported 1"), await d.textContent('aside [data-key="tidy:tidy"]'));
  check(
    "installed plugins and settings are kept with the data and load in a new kernel",
    dPlugins.includes("late") && !dPlugins.includes("temp") && !dPlugins.includes("liar"),
    dPlugins.join(", "),
  );
  await d.close();

  // ---- Fallback: kernel in a dedicated worker ----
  const isolated = await browser.newContext();
  const c = await isolated.newPage();
  c.on("pageerror", (e) => errors.push(e.message));
  await c.goto(`${URL}?kernel=dedicated`);
  await c.waitForFunction(() => window.__host && window.__host.workers.size === 10, null, { timeout: 10000 });
  check("the kernel also runs in a dedicated worker", (await c.textContent("#mode")).includes("dedicated worker"));
  await isolated.close();

  check("no uncaught errors in any page", errors.length === 0, errors.join("; "));
} catch (error) {
  check("the run finished", false, String(error));
} finally {
  await browser.close();
  server.kill();
}

console.log("\nMeasurements:", JSON.stringify(measurements, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
