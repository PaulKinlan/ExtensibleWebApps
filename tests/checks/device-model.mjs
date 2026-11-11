// A model with no key: Chrome's built-in model (std/llm/chrome.js, through
// std/device-model/module.ts and the page's bridge to the Prompt API).
//
// The Chromium the tests run has the API but no model to download, so both
// halves put a stand-in in the page before it loads. One says the browser
// has no model (as Chrome does on a phone, or a computer too small for it,
// and as every other browser does by having no `LanguageModel` at all):
// there the provider lists nothing and the site doesn't offer it. The other
// has the API's own shape (availability, create, prompt, destroy), so the
// check covers everything of ours between a question and the answer. It
// can't say what the real model answers: that needs a Chrome that has it.
//
// Each half runs in a browser context of its own, on the contacts demo, which
// links no model.

import { watchErrors } from "../page-errors.mjs";

/** The stand-in: answers from what it was sent, and keeps every call for the check to read. */
const STAND_IN = (availability) => `(() => {
  const calls = (window.__modelCalls = []);
  let state = ${JSON.stringify(availability)};
  window.__modelState = (next) => (state = next);
  window.LanguageModel = {
    availability: async () => state,
    create: async (options = {}) => {
      calls.push({ create: options.initialPrompts ?? [] });
      if (state !== "available") { options.monitor?.({ addEventListener: (name, heard) => heard({ loaded: 0.4 }) }); return new Promise(() => {}); }
      const system = (options.initialPrompts ?? []).find((p) => p.role === "system")?.content ?? "";
      return {
        contextUsage: 100,
        measureContextUsage: async () => 7,
        async prompt(turns, opts) {
          calls.push({ prompt: turns, constraint: opts?.responseConstraint });
          this.contextUsage = 130;
          const asked = turns[turns.length - 1].content;
          if (asked.startsWith("too long")) throw new DOMException("too much", "QuotaExceededError");
          if (opts?.responseConstraint?.properties?.tool) return JSON.stringify(asked.startsWith("The ") ? { tool: "none", answer: "Done: " + asked.slice(0, 40) } : { tool: opts.responseConstraint.properties.tool.enum[0], args: { city: "Leeds" } });
          if (opts?.responseConstraint) return JSON.stringify({ count: 3 });
          return "From this computer. Told about " + (system.includes("- People (") ? "People" : "nothing") + ". You asked: " + asked;
        },
        destroy() { calls.push({ destroy: true }); },
      };
    },
  };
})();`;

/** A plugin that says which models its app has and which the site offers, once the model plugins have had time to start. */
const LISTER = `export const manifest = { id: "model-lister", name: "Model lister", permissions: ["llm"], services: ["llm"] };
export default async (ctx) => {
  let providers = [];
  for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 600)); providers = await ctx.call("llm", "providers"); }
  ctx.log("providers " + JSON.stringify(providers));
  ctx.log("choices " + JSON.stringify((await ctx.call("llm", "choices")).map((c) => c.id)));
};`;

/** A plugin that asks Chrome's model with tools, for a shape, and for too much, and logs each answer. */
const ASKER = `export const manifest = { id: "model-asker", name: "Model asker", permissions: ["llm"], services: ["llm"] };
export default async (ctx) => {
  const say = async (what, run) => ctx.log(what + " " + JSON.stringify(await run().catch((e) => ({ error: e.message }))));
  const tools = [{ name: "weather", description: "The weather in a city.", parameters: { type: "object", properties: { city: { type: "string" } } } }];
  const first = await ctx.call("llm", "complete", { provider: "llm-chrome", messages: [{ role: "user", content: "Weather?" }], tools }).catch((e) => ({ error: e.message }));
  ctx.log("tool-call " + JSON.stringify(first));
  if (!first.error) await say("tool-answer", () => ctx.call("llm", "complete", { provider: "llm-chrome", tools, messages: [{ role: "user", content: "Weather?" }, first.message, { role: "tool", id: first.toolCalls[0].id, name: "weather", content: "Rain" }] }));
  await say("shaped", () => ctx.call("llm", "complete", { provider: "llm-chrome", messages: [{ role: "user", content: "How many?" }], schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] } }));
  await say("long", () => ctx.call("llm", "complete", { provider: "llm-chrome", messages: [{ role: "user", content: "too long, this one" }] }));
  await say("models", () => ctx.call("llm", "models", "llm-chrome"));
};`;

const APP = "demos/contacts";

async function open(browser, URL, errors, name, availability) {
  const own = await browser.newContext();
  await own.addInitScript(availability ? STAND_IN(availability) : "Object.defineProperty(window, 'LanguageModel', { value: undefined, configurable: true });");
  const page = await own.newPage();
  watchErrors(page, errors, name);
  await page.goto(`${URL}${APP}/app.html`);
  await page.waitForFunction(() => window.__host);
  const command = (cmd, args) => page.evaluate(([cmd, args]) => window.__host.command(cmd, args), [cmd, { app: APP, ...args }]);
  const log = (prefix, timeout = 15000) =>
    page
      .waitForFunction((p) => window.__host.traces.findLast((e) => e.plugin?.startsWith("model-") && e.detail?.startsWith(p))?.detail, `${prefix} `, { timeout })
      .then((h) => h.jsonValue(), () => "")
      .then((line) => (line ? JSON.parse(line.slice(prefix.length + 1)) : undefined));
  const seen = (selector, timeout = 10000) => page.waitForSelector(selector, { state: "attached", timeout }).then(() => true, () => false);
  const source = async (path) => (await page.request.get(`${URL}${path}`)).text();
  /** Adds one of the plugins above as the person's own and starts it. */
  const start = async (id, data) => {
    await command("user:add", { files: [{ name: `${id}.js`, data }] });
    await command("user:on", { id });
  };
  return { own, page, command, log, start, seen, source };
}

export default async function ({ check, context, URL, errors }) {
  const browser = context.browser();

  // ---- A browser with no built-in model: the provider is absent ----
  {
    const t = await open(browser, URL, errors, "device-model (none)");
    const said = await open(browser, URL, errors, "device-model (unavailable)", "unavailable");
    try {
      // Even added by hand and turned on, it lists no model here.
      await t.command("user:add", { files: [{ name: "chrome.js", data: await t.source("std/llm/chrome.js") }] });
      await t.command("user:on", { id: "llm-chrome" });
      await t.start("model-lister", LISTER);
      const providers = await t.log("providers");
      const choices = await t.log("choices");
      check("in a browser with no built-in model, Chrome's model isn't one of the app's models, even when its plugin is on", Array.isArray(providers) && !providers.some((p) => p.id === "llm-chrome"), JSON.stringify(providers));
      check("and the site doesn't offer it there, beside the models it does offer", Array.isArray(choices) && choices.includes("llm-anthropic") && !choices.includes("llm-chrome"), JSON.stringify(choices));
      await said.start("model-lister", LISTER);
      const offered = await said.log("choices");
      check("nor where the browser has the API and says it has no model for this device", Array.isArray(offered) && offered.includes("llm-anthropic") && !offered.includes("llm-chrome"), JSON.stringify(offered));
    } finally {
      for (const id of ["llm-chrome", "model-lister"]) await t.command("user:remove", { id }).catch(() => {});
      await said.command("user:remove", { id: "model-lister" }).catch(() => {});
      await t.own.close();
      await said.own.close();
    }
  }

  // ---- A browser that has it: a person with no key gets an answer ----
  {
    const t = await open(browser, URL, errors, "device-model", "available");
    const { page } = t;
    const review = '[data-key^="review:"]';
    const accept = async (what) => {
      await page.waitForSelector(`${review} >> text=${what}`, { timeout: 15000 });
      await page.click(`${review} button:has-text("Accept")`);
      await page.waitForSelector(review, { state: "detached", timeout: 10000 }).catch(() => {});
    };
    try {
      await page.click("ui-panel .launch");
      await page.click('[data-package="ask-the-page"]');
      await accept("adds Ask the page");
      await page.waitForSelector('[data-toggle="ask-the-page"]:has-text("Turn off")', { timeout: 10000 });
      await page.click("ui-panel .close, ui-panel [data-action='panel']").catch(() => page.keyboard.press("Escape"));
      const ask = '[data-key^="ask-the-page@"]';
      const offered = await t.seen(`${ask} [data-action="model:llm-chrome"]`);
      check("in a browser that has a built-in model, Ask the page offers it on a page with no model", offered, offered ? "" : ((await page.textContent(ask).catch(() => "")) ?? "").slice(0, 300));
      await page.click(`${ask} [data-action="model:llm-chrome"]`);
      await accept("adds Chrome's built-in model");
      check("once added it is one of the app's models", await t.seen(`${ask} option[value="llm-chrome"]`));

      await page.fill(`${ask} input[name="question"]`, "What is on this page?");
      await page.click(`${ask} button[type="submit"]`);
      const answered = await t.seen(`${ask} .answer >> text=From this computer. Told about People. You asked: What is on this page?`, 15000);
      const text = `${(await page.textContent(`${ask} .answer`).catch(() => "")) ?? ""} ${(await page.textContent(`${ask} .error`).catch(() => "")) ?? ""}`;
      check("with no key anywhere, Ask the page answers from the browser's own model", answered, text.slice(0, 300));
      check("and no card asked for a key", !(await page.isVisible('[data-key^="secret:"], [data-key^="review:"]').catch(() => false)) && !/API key/i.test(text));
      check("the answer says which model answered and what it took", await t.seen(`${ask} .about-answer >> text=Answered by Chrome's built-in model, chrome-built-in · 107 in, 23 out tokens`, 3000), (await page.textContent(`${ask} .about-answer`).catch(() => "")) ?? "");
      const calls = await page.evaluate(() => window.__modelCalls);
      const made = calls.find((c) => c.create?.length);
      check(
        "the browser's model was given the page as its system prompt, asked the question, and its session ended",
        made?.create[0].role === "system" && /The plugins on this page/.test(made.create[0].content) && calls.some((c) => c.prompt?.[0]?.content === "What is on this page?") && calls.some((c) => c.destroy),
      );

      // Tools and shaped answers, which the browser's model has no calls of its own for.
      await t.start("model-asker", ASKER);
      const call = await t.log("tool-call");
      check("a request with tools comes back as a tool call, read from an answer of a fixed shape", call?.stop === "tool" && call.toolCalls?.[0]?.name === "weather" && call.toolCalls[0].args.city === "Leeds", JSON.stringify(call));
      const after = await t.log("tool-answer");
      check("and the tool's answer goes back for the model to finish", after?.stop === "end" && /^Done: The weather tool answered/.test(after.text ?? ""), JSON.stringify(after));
      const shaped = await t.log("shaped");
      check("an answer of a shape asked for arrives as json", shaped?.json?.count === 3, JSON.stringify(shaped));
      const long = await t.log("long");
      check("more than the model can read is an error that says what to do", /Ask something shorter, or pick a larger model/.test(long?.error ?? ""), JSON.stringify(long));
      const models = await t.log("models");
      check("every tier stands for the one model the browser has", models?.tiers?.fast === "chrome-built-in" && models.tiers.best === "chrome-built-in", JSON.stringify(models));

      // The browser can have the model but hasn't fetched it: the answer says so, and how far it has got.
      await page.evaluate(() => window.__modelState("downloadable"));
      await page.fill(`${ask} input[name="question"]`, "Still there?");
      await page.click(`${ask} button[type="submit"]`);
      const waiting = await t.seen(`${ask} >> text=/Chrome is downloading its built-in model/`, 15000);
      check("while Chrome still has to download its model, the person is told, and what to do", waiting, ((await page.textContent(ask).catch(() => "")) ?? "").slice(-300));
      await page.evaluate(() => window.__modelState("downloading"));
      await page.click(`${ask} button[type="submit"]`);
      check("and how far the download has got", await t.seen(`${ask} >> text=/40% so far/`, 15000));

    } finally {
      for (const id of ["llm-chrome", "model-asker", "ask-the-page"]) await t.command("user:remove", { id }).catch(() => {});
      await t.own.close();
    }
  }
}
