// The model-driven features, tried with a real model in a real browser:
// Ask the page and the builder on the homepage, the Plugin maker on a demo
// that links no model, and the app maker at /new/. A person would paste their
// own key; here it comes from GEMINI_API_KEY and goes into the kernel's own
// key card, the way a person gives it.
//
//   npm run build && GEMINI_API_KEY=… node tests/real-model/run.mjs
//
// It is not part of `npm test`: it costs money, needs a key and a network,
// and a model doesn't answer the same way twice. Only
// .github/workflows/real-model.yml runs it, started by hand.
//
// The key is never printed, logged or written: it goes only into a password
// field whose card names Gemini and Google's host, and everything this
// writes (report, traces, made files) has the key's text taken out first.
// Screenshots are taken only while no key card is on the screen.
//
//   FEATURES   which to run, comma separated: ask, builder, plugin-maker,
//              app-maker (default: all)
//   OUT        where the report, screenshots and made files go
//              (default .build/real-model)
//   MODEL      which Gemini model answers: a tier (best, balanced, fast) or a
//              model's id. Without it each feature uses what it ships with,
//              which is `best`. With it, the built site in dist/ is changed
//              for the length of the run and put back after: the Gemini
//              provider's default model, and the app maker's `model:`.
//
// Exits non-zero if any check fails.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const KEY = (process.env.GEMINI_API_KEY ?? "").trim();
if (!KEY) {
  console.error("GEMINI_API_KEY is not set. This run needs a real Gemini API key; it has no scripted model to fall back to.");
  process.exit(2);
}
const KNOWN = ["ask", "builder", "plugin-maker", "app-maker"];
const FEATURES = (process.env.FEATURES || KNOWN.join(",")).split(",").map((f) => f.trim()).filter(Boolean);
const unknown = FEATURES.filter((f) => !KNOWN.includes(f));
if (unknown.length) {
  console.error(`FEATURES names ${unknown.join(", ")}, which isn't one of ${KNOWN.join(", ")}.`);
  process.exit(2);
}
const ROOT = fileURLToPath(new globalThis.URL("../../", import.meta.url));
const MODEL = (process.env.MODEL ?? "").trim();
if (MODEL && !/^[a-z0-9][a-z0-9.-]{1,60}$/.test(MODEL)) {
  console.error("MODEL is a tier (best, balanced, fast) or a model's id, such as gemini-3.8-flash.");
  process.exit(2);
}
const OUT = process.env.OUT ? process.env.OUT : join(ROOT, ".build/real-model");
mkdirSync(OUT, { recursive: true });

/**
 * The model choice, made in the built site the run serves. Each change must find its line: a file that no longer
 * says what this expects fails the run, so a run never quietly uses another model than the one asked for.
 */
const restore = [];
// Put back however the run ends.
process.on("exit", () => restore.splice(0).forEach((undo) => undo()));
if (MODEL) {
  const change = (file, from, to) => {
    const path = join(ROOT, "dist", file);
    const text = readFileSync(path, "utf8");
    if (text.split(from).length !== 2) {
      console.error(`Can't set the model: dist/${file} doesn't have exactly one ${JSON.stringify(from)}. Run npm run build first.`);
      process.exit(2);
    }
    restore.push(() => writeFileSync(path, text));
    writeFileSync(path, text.replace(from, to));
  };
  change("std/llm/gemini.js", 'default: "best",', `default: ${JSON.stringify(MODEL)},`);
  change("std/maker/app-maker.agent.md", "\nmodel: best\n", `\nmodel: ${MODEL}\n`);
}

const PORT = 4179;
const URL = `http://localhost:${PORT}/`;
const PROVIDER = "llm-gemini";
const OTHERS = ["llm-anthropic", "llm-openai"];

/** Text with the key taken out, for anything written or printed. */
const clean = (text) => String(text ?? "").split(KEY).join("[key]");
const log = (...parts) => console.log(clean(parts.join(" ")));

const results = [];
const features = {};
let current = "";
function check(name, ok, detail = "") {
  results.push({ feature: current, name, ok: !!ok, detail: clean(detail).slice(0, 1500) });
  log(`${ok ? "PASS" : "FAIL"}  [${current}] ${name}${detail ? `  (${clean(detail).slice(0, 400)})` : ""}`);
}

const server = spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: "pipe", cwd: ROOT });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && resolve());
  server.on("exit", (code) => reject(new Error(`vite preview exited with ${code}`)));
  setTimeout(resolve, 5000);
});

const browser = await chromium.launch();
const review = '[data-key^="review:"]';
const keyCard = '[data-key^="secrets:"]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What a person does while a model works, done for them: pastes the key when
 * the Gemini key card asks, and accepts each review card (after noting what
 * it said). Returns what it saw, and `stop`.
 */
function attend(page, name) {
  const seen = { cards: [], keys: 0, refusedKeyCards: [], shots: 0 };
  let going = true;
  const loop = (async () => {
    while (going && !page.isClosed()) {
      try {
        const card = await page.$(keyCard);
        if (card) {
          const text = (await card.innerText()).replace(/\s+/g, " ");
          // Only ever into a card that is for Gemini's key and Google's host.
          if (/Gemini API key/.test(text) && /only ever sent to generativelanguage\.googleapis\.com\./.test(text)) {
            await card.$("input[type=password]").then((f) => f.fill(KEY));
            await page.keyboard.press("Tab");
            await page.click(`${keyCard} button:has-text("Save")`);
            await page.waitForSelector(keyCard, { state: "detached", timeout: 5000 }).catch(() => {});
            seen.keys++;
          } else {
            seen.refusedKeyCards.push(text.slice(0, 200));
            await page.click(`${keyCard} button:has-text("Not now")`).catch(() => {});
          }
          continue;
        }
        const reviewCard = await page.$(review);
        if (reviewCard) {
          const text = (await reviewCard.innerText()).replace(/\s+/g, " ");
          await shot(page, `${name}-review-${++seen.shots}`);
          const acting = /act for you\?/.test(text);
          seen.cards.push(text.slice(0, 600));
          await page.click(`${review} button:has-text("${acting ? "This time" : "Accept"}")`, { timeout: 5000 });
          await page.waitForFunction(([s, t]) => ![...document.querySelectorAll(s)].some((c) => c.innerText.replace(/\s+/g, " ").startsWith(t)), [review, text.slice(0, 80)], { timeout: 5000 }).catch(() => {});
          continue;
        }
      } catch {
        // The page moved under us: look again.
      }
      await sleep(400);
    }
  })();
  return { seen, stop: async () => ((going = false), loop) };
}

/** A screenshot, never while a key card is up. */
async function shot(page, name, options = {}) {
  if (page.isClosed() || (await page.$(keyCard).catch(() => null))) return;
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false, ...options }).catch(() => {});
}

/** The trace lines that say what the model and its tools did, and what went wrong. */
const story = (page) =>
  page
    .evaluate(() =>
      window.__host.traces
        .filter((e) => e.kind === "error" || /^(llm:|agent:|net:|secret:|maker:|plugin:(failed|stopped|start-timeout|manifest)|review|change:|tools?:)/.test(e.name) || /maker\.|authoring\.|tools\./.test(e.name))
        .map((e) => `${e.kind} ${e.name} ${e.plugin ?? ""} ${e.ms != null ? `${e.ms}ms ` : ""}${e.detail ?? ""}`.slice(0, 1200)),
    )
    .catch(() => []);

/** What the model calls cost, from the trace: [{ model, input, output }] summed by model. */
function usage(lines) {
  const by = {};
  for (const line of lines) {
    const m = /^call llm:complete \S* (?:\d+ms )?\S+ (\S+) \S+, (\d+) in, (\d+) out/.exec(line);
    if (!m) continue;
    by[m[1]] ??= { calls: 0, input: 0, output: 0 };
    by[m[1]].calls++;
    by[m[1]].input += Number(m[2]);
    by[m[1]].output += Number(m[3]);
  }
  return by;
}

/** The code of the person's own plugins with these ids, found by file name in the device's folder. Reads only <id>.js files. */
const sources = (page, ids) =>
  page
    .evaluate(async (ids) => {
      const out = {};
      const wanted = new Set(ids.map((id) => `${id}.js`));
      const walk = async (folder, path, depth) => {
        for await (const [name, handle] of folder.entries()) {
          if (handle.kind === "directory") depth < 6 && (await walk(handle, `${path}${name}/`, depth + 1));
          else if (wanted.has(name)) out[`${path}${name}`] = await (await handle.getFile()).text();
        }
      };
      await walk(await navigator.storage.getDirectory(), "", 0).catch((error) => (out.error = String(error)));
      return out;
    }, ids)
    .then((found) => clean(JSON.stringify(found)).slice(0, 8000), () => "");

async function open(context, url, errors) {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(clean(`${e.message} (at ${new globalThis.URL(page.url()).pathname})`)));
  await page.goto(url);
  await page.waitForFunction(() => window.__host, null, { timeout: 20000 });
  return page;
}
/** Whether text a person reads has Markdown's marks left in it: the pages show answers as plain text. */
const markdown = (text) => /\*\*|`|^#{1,4} /m.test(String(text ?? ""));
const has = (page, selector, timeout = 10000) => page.waitForSelector(selector, { state: "attached", timeout }).then(() => true, () => false);

/** Leaves Gemini as the only model switched on, as a person with only a Gemini key would, from the page's switchboard. */
async function onlyGemini(page) {
  for (const id of OTHERS) {
    const toggle = `slot[name="switchboard"] input[data-action="switch:${id}"]`;
    if (!(await has(page, toggle, 10000))) return false;
    if (await page.isChecked(toggle)) await page.click(toggle);
  }
  await sleep(1500);
  return true;
}

/** Runs one feature in a browser context of its own, so each starts as a new person with no key and no data. */
async function feature(name, run) {
  if (!FEATURES.includes(name)) return;
  current = name;
  const started = Date.now();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const pages = [];
  const info = (features[name] = { ok: false, seconds: 0, usage: {}, cards: [], trace: [], errors, notes: {} });
  try {
    await run({ context, errors, info, track: (page) => (pages.push(page), page) });
  } catch (error) {
    check("the run got to its end", false, error instanceof Error ? error.message : String(error));
  }
  for (const page of pages) if (!page.isClosed()) info.trace.push(...(await story(page)));
  info.usage = usage(info.trace);
  info.seconds = Math.round((Date.now() - started) / 1000);
  info.ok = results.filter((r) => r.feature === name).every((r) => r.ok);
  check("no page threw an error", errors.length === 0, errors.slice(0, 5).join(" | "));
  await context.close().catch(() => {});
}

// ---- Ask the page, on the homepage ----
await feature("ask", async ({ context, errors, info, track }) => {
  const page = track(await open(context, URL, errors));
  const ask = '[data-key^="ask-the-page@"]';
  check("the homepage's Ask the page lists Gemini", await has(page, `${ask} option[value="${PROVIDER}"]`, 15000));
  await page.selectOption(`${ask} select`, PROVIDER);
  const person = attend(page, "ask");
  await page.fill(`${ask} input[name="question"]`, "How does Quiet please stop a note from being saved?");
  await page.click(`${ask} button[type="submit"]`);
  const answered = await has(page, `${ask} .answer`, 120000);
  await person.stop();
  const text = answered ? await page.textContent(`${ask} .answer`) : await page.textContent(ask).catch(() => "");
  check("the Gemini key card came up once and took the key", person.seen.keys === 1 && !person.seen.refusedKeyCards.length, `${person.seen.keys} key cards; ${person.seen.refusedKeyCards.join(" | ")}`);
  check("Gemini answers a question about a plugin on the page", answered && text.trim().length > 40, text.slice(0, 600));
  // Only the plugin's code says what it stops: notes written all in capitals. A model may name the hook or say it in plain words.
  check("the answer comes from the plugin's code: it says the note is stopped for being all capitals", /capital|upper.?case/i.test(text), text.slice(0, 300));
  const about = (await page.textContent(`${ask} .about-answer`).catch(() => "")) ?? "";
  check("it says which model answered and what it cost", /Answered by Gemini, \S+ · \d+ in, \d+ out tokens/.test(about), about);
  check("the answer reads as plain text, with no Markdown marks left in it", answered && !markdown(text), text.slice(0, 300));
  info.notes.answer = clean(text).slice(0, 2000);
  info.notes.about = about;
  await page.locator(ask).scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, "ask-answer");

  // The tiers are looked up in Google's live model list: say what each stands for today.
  const tiers = await page
    .evaluate(async () => {
      const source = 'export const manifest = { id: "tier-probe", name: "Tier probe", permissions: ["llm"], services: ["llm"] };\nexport default async (ctx) => { ctx.log("tiers " + (await ctx.call("llm", "models", "llm-gemini").then((m) => JSON.stringify({ tiers: m.tiers, count: m.models.length, ids: m.models.map((x) => x.id).filter((id) => /^gemini-/.test(id)) }), (e) => JSON.stringify({ error: e.message })))); };';
      await window.__host.command("user:add", { app: "root", files: [{ name: "tier-probe.js", data: source }] });
      await window.__host.command("user:on", { app: "root", id: "tier-probe" });
      for (let i = 0; i < 60; i++) {
        const line = window.__host.traces.find((e) => e.plugin?.startsWith("tier-probe") && e.detail?.startsWith("tiers "));
        if (line) return line.detail.slice(6);
        await new Promise((r) => setTimeout(r, 500));
      }
      return "";
    })
    .catch((e) => JSON.stringify({ error: String(e) }));
  await person.stop();
  let parsed = {};
  try {
    parsed = JSON.parse(tiers || "{}");
  } catch {}
  info.notes.tiers = parsed.tiers ?? parsed.error ?? "no answer";
  info.notes.geminiModels = parsed.ids ?? [];
  const live = new Set(parsed.ids ?? []);
  check("each tier stands for a model Google lists today", !!parsed.tiers && ["best", "balanced", "fast"].every((t) => live.has(parsed.tiers[t])), clean(tiers).slice(0, 600));
  info.cards = person.seen.cards;
});

// ---- The builder agent, on the homepage ----
await feature("builder", async ({ context, errors, info, track }) => {
  const page = track(await open(context, URL, errors));
  const chat = '[data-key^="chat@"]';
  check("the homepage's chat lists the builder", await has(page, `${chat} option[value="builder"]`, 20000));
  check("with only a Gemini key, a person can switch the other models off", await onlyGemini(page));
  const before = await page.evaluate(() => window.__host.command("user:list", { app: "root" })).catch(() => []);
  await page.selectOption(`${chat} select`, "builder");
  const person = attend(page, "builder");
  await page.fill(`${chat} input[name="text"]`, "Show how many learning notes I have, and how many words they add up to, as a card in the playground");
  await page.click(`${chat} button[type="submit"]`);
  await page.waitForFunction((s) => document.querySelectorAll(`${s} ol li`).length >= 2, chat, { timeout: 300000 }).catch(() => {});
  await sleep(1500);
  await person.stop();
  const lines = await page.$$eval(`${chat} ol li`, (items) => items.map((li) => ({ text: li.innerText, tone: li.querySelector("ui-card")?.getAttribute("tone") ?? "" }))).catch(() => []);
  const reply = lines.at(-1);
  info.notes.reply = clean(reply?.text ?? "").slice(0, 2000);
  info.cards = person.seen.cards;
  check("the Gemini key card came up and took the key", person.seen.keys === 1 && !person.seen.refusedKeyCards.length, `${person.seen.keys} key cards; ${person.seen.refusedKeyCards.join(" | ")}`);
  check("the builder finishes and answers in the chat", lines.length >= 2 && reply?.tone === "accent", `${reply?.tone}: ${reply?.text?.slice(0, 500)}`);
  check("its answer reads as plain text, with no Markdown marks left in it", !!reply && !markdown(reply.text), reply?.text?.slice(0, 300));
  check("it asked to act for the person, then showed its plugin on a review card", person.seen.cards.some((c) => /act for you\?/.test(c)) && person.seen.cards.some((c) => /wants to change your plugins: adds /.test(c)), person.seen.cards.map((c) => c.slice(0, 120)).join(" | "));
  const after = await page.evaluate(() => window.__host.command("user:list", { app: "root" })).catch(() => []);
  const made = after.filter((p) => !before.some((b) => b.id === p.id));
  info.notes.made = made.map((p) => p.id);
  check("the plugin it wrote is the person's own, and switched on", made.length >= 1 && made.every((p) => p.on), JSON.stringify(made));
  await sleep(2000);
  const failed = (await story(page)).filter((l) => made.some((p) => l.includes(p.id)) && /plugin:failed|plugin:stopped|^error /.test(l));
  check("the plugin it wrote runs without an error", made.length >= 1 && failed.length === 0, failed.slice(0, 3).join(" | "));
  const drawn = made.length ? await page.evaluate((ids) => ids.map((id) => [...document.querySelectorAll(`[data-key^="${id}:"], [data-key^="${id}@"]`)].map((el) => [el.innerText.trim(), ...[...el.querySelectorAll("[value], [label]")].map((x) => `${x.getAttribute("label") ?? ""} ${x.getAttribute("value") ?? ""}`.trim())].filter(Boolean).join(" · ").slice(0, 200))).flat(), made.map((p) => p.id)) : [];
  info.notes.drawn = drawn;
  check("what it drew is on the page, with a number in it", drawn.some((t) => /\d/.test(t)), drawn.join(" | ").slice(0, 400));
  for (const p of made) {
    const el = page.locator(`[data-key^="${p.id}:"], [data-key^="${p.id}@"]`).first();
    await el.scrollIntoViewIfNeeded().catch(() => {});
  }
  await shot(page, "builder-plugin");
  await page.locator(chat).scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, "builder-chat");
  info.notes.code = await sources(page, made.map((p) => p.id));
});

// ---- The Plugin maker, added by a person to an app that links no model ----
await feature("plugin-maker", async ({ context, errors, info, track }) => {
  const app = "demos/contacts";
  const page = track(await open(context, `${URL}${app}/app.html`, errors));
  const command = (name, args) => page.evaluate(([name, args]) => window.__host.command(name, args), [name, { app, ...args }]);
  const person = attend(page, "plugin-maker");
  await page.click("ui-panel .launch");
  await page.click('[data-package="plugin-maker"]');
  await has(page, '[data-toggle="plugin-maker"]:has-text("Turn off")', 20000);
  await page.click("ui-panel .close, ui-panel [data-action='panel']").catch(() => page.keyboard.press("Escape"));
  const maker = '[data-key^="plugin-maker@"]';
  check("a person adds the Plugin maker from Customize", await has(page, maker, 15000));
  check("with no model on the page, it offers Gemini to add", await has(page, `${maker} [data-action="model:${PROVIDER}"]`, 10000));
  await shot(page, "plugin-maker-add-a-model");
  await page.click(`${maker} [data-action="model:${PROVIDER}"]`);
  check("accepting Gemini's review card makes it the page's model", await has(page, `${maker} option[value="${PROVIDER}"]`, 20000));
  const before = await command("user:list", {}).catch(() => []);
  await page.fill(`${maker} input[name="text"]`, "Show how many people are in my contacts, at the top of the page");
  await page.click(`${maker} button[type="submit"]`);
  // Done when its form can be sent again.
  await page.waitForFunction((s) => document.querySelectorAll(`${s} ol.lines li`).length >= 2 && !document.querySelector(`${s} form button[type=submit]`)?.disabled, maker, { timeout: 300000 }).catch(() => {});
  await sleep(1500);
  await person.stop();
  const lines = await page.$$eval(`${maker} ol.lines li`, (items) => items.map((li) => ({ text: li.innerText, tone: li.querySelector("ui-card")?.getAttribute("tone") ?? "" }))).catch(() => []);
  info.notes.lines = lines.map((l) => clean(`${l.tone ? `[${l.tone}] ` : ""}${l.text}`).slice(0, 600));
  info.cards = person.seen.cards;
  check("the Gemini key card came up and took the key", person.seen.keys === 1 && !person.seen.refusedKeyCards.length, `${person.seen.keys} key cards; ${person.seen.refusedKeyCards.join(" | ")}`);
  check("the Plugin maker finishes without an error line", lines.length >= 2 && !lines.some((l) => l.tone === "danger"), lines.filter((l) => l.tone === "danger").map((l) => l.text.slice(0, 300)).join(" | ") || lines.at(-1)?.text?.slice(0, 300));
  check("its answer reads as plain text, with no Markdown marks left in it", lines.length >= 2 && !markdown(lines.at(-1).text), lines.at(-1)?.text?.slice(0, 300));
  const after = await command("user:list", {}).catch(() => []);
  const made = after.filter((p) => !before.some((b) => b.id === p.id));
  info.notes.made = made.map((p) => p.id);
  check("it saved a plugin, after a review card, as the person's own and switched on", made.length >= 1 && made.every((p) => p.on) && person.seen.cards.some((c) => /adds /.test(c)), JSON.stringify(made));
  await sleep(2000);
  const failed = (await story(page)).filter((l) => made.some((p) => l.includes(p.id)) && /plugin:failed|plugin:stopped|^error /.test(l));
  check("the plugin it wrote runs without an error", made.length >= 1 && failed.length === 0, failed.slice(0, 3).join(" | "));
  const people = await page.$$eval("ui-table tbody tr", (rows) => rows.length).catch(() => 0);
  const drawn = made.length ? await page.evaluate((ids) => ids.map((id) => [...document.querySelectorAll(`[data-key^="${id}:"], [data-key^="${id}@"]`)].map((el) => [el.innerText.trim(), ...[...el.querySelectorAll("[value], [label]")].map((x) => `${x.getAttribute("label") ?? ""} ${x.getAttribute("value") ?? ""}`.trim())].filter(Boolean).join(" · ").slice(0, 200))).flat(), made.map((p) => p.id)) : [];
  info.notes.drawn = drawn;
  info.notes.rowsOnPage = people;
  check("what it drew is on the page, with a number in it", drawn.some((t) => /\d/.test(t)), drawn.join(" | ").slice(0, 400));
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "plugin-maker-result");
  await page.locator(maker).scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, "plugin-maker-chat");
  info.notes.code = await sources(page, made.map((p) => p.id));
});

// ---- The app maker, at /new/ ----
await feature("app-maker", async ({ context, errors, info, track }) => {
  const page = track(await open(context, `${URL}new/`, errors));
  const make = '[data-key^="your-apps@"][data-key$=":make"]';
  const yours = '[data-key^="your-apps@"][data-key$=":apps"]';
  check("the page to make an app opens", await has(page, `${make} textarea`, 20000));
  check("with only a Gemini key, a person can switch the other models off", await onlyGemini(page));
  const person = attend(page, "app-maker");
  /** Asks the app maker, and waits until it has stopped working. */
  const ask = async (text, target = "") => {
    await page.selectOption(`${make} select[name="app"]`, target);
    await page.fill(`${make} textarea[name="text"]`, text);
    await page.click(`${make} button[type="submit"]`);
    await page.waitForSelector(`${make} [role="status"]`, { timeout: 15000 }).catch(() => {});
    await page.waitForSelector(`${make} [role="status"]`, { state: "detached", timeout: 900000 }).catch(() => {});
    await sleep(1500);
    return {
      answer: clean((await page.textContent(`${make} .answer`).catch(() => "")) ?? ""),
      tone: (await page.getAttribute(`${make} ui-card:has(> .answer)`, "tone").catch(() => "")) ?? "",
      steps: await page.$$eval(`${make} ol li`, (items) => items.map((li) => li.innerText)).catch(() => []),
    };
  };
  /** The files of every app the person has made, read from the device's folder. */
  const files = () =>
    page.evaluate(async () => {
      const out = {};
      try {
        let dir = await navigator.storage.getDirectory();
        for (const part of ["made", "apps"]) dir = await dir.getDirectoryHandle(part);
        const walk = async (folder, path) => {
          for await (const [name, handle] of folder.entries()) {
            if (handle.kind === "directory") await walk(handle, `${path}${name}/`);
            else out[`${path}${name}`] = await (await handle.getFile()).text();
          }
        };
        await walk(dir, "");
      } catch (error) {
        out["error.txt"] = String(error);
      }
      return out;
    });
  const save = async (folder) => {
    const made = await files().catch(() => ({}));
    for (const [path, text] of Object.entries(made)) {
      const to = join(OUT, folder, path);
      mkdirSync(join(to, ".."), { recursive: true });
      writeFileSync(to, clean(text));
    }
    return made;
  };
  /** Opens the made app in a tab of its own, as a person would, and tries it. */
  const tryApp = async (name, label) => {
    const tab = track(await open(context, `${URL}apps/${name}/`, errors));
    await sleep(4000);
    const trace = await story(tab);
    const broken = trace.filter((l) => /plugin:failed|plugin:stopped|plugin:start-timeout|^error /.test(l));
    check(`${label}: the app opens in a tab of its own and every plugin starts`, broken.length === 0, broken.slice(0, 4).join(" | "));
    const body = await tab.evaluate(() => document.body.innerText);
    check(`${label}: it shows a Sunday reminder`, /sunday|reminder/i.test(body), body.slice(0, 300));
    // Add a book the way a person would: the first form with a text field.
    const field = tab.locator('main form input[type="text"], main form input:not([type])').first();
    const title = `Piranesi ${Date.now() % 1000}`;
    let added = false;
    if (await field.count()) {
      await field.fill(title);
      const form = tab.locator("main form").filter({ has: field }).first();
      await form.locator('button[type="submit"], button:not([type])').first().click().catch(() => field.press("Enter"));
      // getByText reads what is shown, inside the platform's elements too, and never a field's value.
      added = await tab.locator("main").getByText(title).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
    }
    check(`${label}: a book typed into its form shows in its list`, added, added ? title : (await tab.evaluate(() => document.querySelector("main")?.innerHTML.slice(0, 600) ?? "no main")));
    await shot(tab, `app-maker-${label}-desktop`, { fullPage: true });
    await tab.setViewportSize({ width: 390, height: 844 });
    await sleep(500);
    const wide = await tab.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(`${label}: it fits a phone's width`, !wide);
    await shot(tab, `app-maker-${label}-phone`, { fullPage: true });
    await tab.setViewportSize({ width: 1280, height: 900 });
    return tab;
  };

  const first = await ask("A reading list with a Sunday reminder");
  info.notes.first = first;
  await shot(page, "app-maker-made", { fullPage: true });
  check("the Gemini key card came up and took the key", person.seen.keys === 1 && !person.seen.refusedKeyCards.length, `${person.seen.keys} key cards; ${person.seen.refusedKeyCards.join(" | ")}`);
  check("the app maker finishes and says where the app is", first.tone !== "danger" && /\/apps\/[a-z0-9-]+\//.test(first.answer), `${first.tone}: ${first.answer.slice(0, 600)}`);
  check("its answer reads as plain text, with no Markdown marks left in it", !markdown(first.answer), first.answer.slice(0, 300));
  const firstFiles = await save("made-1");
  const names = [...new Set(Object.keys(firstFiles).map((p) => p.split("/")[0]))].filter((n) => firstFiles[`${n}/app.html`]);
  info.notes.apps = names;
  const name = /\/apps\/([a-z0-9-]+)\//.exec(first.answer)?.[1] ?? names[0];
  check("it saved an app, page and plugins, after a review card", names.length === 1 && person.seen.cards.some((c) => /makes .* at \/apps\//.test(c)), `${names.join(", ")}: ${Object.keys(firstFiles).join(" ")}`);
  check("its own check of the running app passed before it stopped", first.steps.length > 0 && !/still (wrong|failing|broken)|couldn't fix/i.test(first.answer), first.steps.slice(-6).join(" | "));
  if (!name) return;
  const tab = await tryApp(name, "first");

  // A follow-up change, with the app still open in the other tab.
  const cardsBefore = person.seen.cards.length;
  const second = await ask("add a rating from 1 to 5 for each book", name);
  info.notes.second = second;
  await shot(page, "app-maker-changed", { fullPage: true });
  check("a follow-up change finishes too", second.tone !== "danger" && second.answer.length > 0, `${second.tone}: ${second.answer.slice(0, 600)}`);
  check("the change went through a review card", person.seen.cards.slice(cardsBefore).some((c) => /your app .*: changes /.test(c)), person.seen.cards.slice(cardsBefore).map((c) => c.slice(0, 160)).join(" | "));
  const secondFiles = await save("made-2");
  check("the files now have a rating", Object.entries(secondFiles).some(([path, text]) => path.startsWith(`${name}/`) && /rating/i.test(text)));
  check("the open app got the change without a reload", await tab.waitForFunction(() => /rating/i.test(document.querySelector("main")?.innerHTML ?? ""), null, { timeout: 15000 }).then(() => true, () => false));
  await tab.close();
  const again = await tryApp(name, "changed");
  check("the changed app has a rating to fill in", await again.evaluate(() => /rating/i.test(document.querySelector("main")?.innerHTML ?? "")));
  await person.stop();
  info.cards = person.seen.cards;
  const preview = await page.frameLocator(`${yours} ui-preview >> iframe`).locator("main").innerText({ timeout: 5000 }).catch(() => "");
  check("the preview on the page runs the app", preview.trim().length > 0, preview.slice(0, 200));
});

await browser.close();
server.kill();

// ---- The report: nothing in it, or in any text file beside it, may hold the key ----
const failed = results.filter((r) => !r.ok);
const total = {};
for (const f of Object.values(features)) for (const [model, u] of Object.entries(f.usage)) {
  total[model] ??= { calls: 0, input: 0, output: 0 };
  for (const k of ["calls", "input", "output"]) total[model][k] += u[k];
}
const md = [
  `# Model features with a real Gemini model`,
  ``,
  `${results.length - failed.length} of ${results.length} checks passed. Features run: ${FEATURES.join(", ")}. Model asked for: ${MODEL || "each feature's own (best)"}.`,
  ``,
  `| Model | Calls | Tokens in | Tokens out |`,
  `| --- | ---: | ---: | ---: |`,
  ...Object.entries(total).map(([model, u]) => `| ${model} | ${u.calls} | ${u.input} | ${u.output} |`),
  ``,
  ...Object.entries(features).flatMap(([name, f]) => [
    `## ${name}: ${f.ok ? "passed" : "FAILED"} (${f.seconds} s)`,
    ``,
    ...results.filter((r) => r.feature === name).map((r) => `- ${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : `\n  - \`${r.detail.replace(/`/g, "'").replace(/\s+/g, " ").slice(0, 500)}\``}`),
    ``,
  ]),
].join("\n");
writeFileSync(join(OUT, "summary.md"), clean(md));
writeFileSync(join(OUT, "report.json"), clean(JSON.stringify({ features, results, total }, null, 2)));

/** Every text file written: fail, and blank the file, if the key is in one. */
let leaked = 0;
(function sweep(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sweep(path);
    else if (readFileSync(path).includes(KEY)) {
      writeFileSync(path, "Removed: this file held the API key.");
      leaked++;
    }
  }
})(OUT);
if (leaked) console.error(`${leaked} file(s) held the key and were blanked.`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, clean(md) + "\n");
log(`\n${results.length - failed.length} of ${results.length} checks passed. Report: ${join(OUT, "summary.md")}`);
process.exit(failed.length || leaked ? 1 : 0);
