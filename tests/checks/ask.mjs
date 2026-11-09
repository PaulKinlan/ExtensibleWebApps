// Ask the page, on the homepage (std/ask-the-page.js, site/home/chapter-6-models.js):
// a scripted model, added as the person's own plugin, stands in for a vendor,
// so the check covers what the plugin sends and how the answer is shown,
// without a key or a network.
//
// It runs in a browser context of its own, like the homepage's check.

import { watchErrors } from "../page-errors.mjs";

/** A model that says which plugins it was told about, and whether it got code. */
const MODEL = `export const manifest = { id: "scripted-model", name: "Scripted model", permissions: ["provide:llm"] };
export default (ctx) => {
  ctx.on("llm:providers", (value) => ({ providers: [...value.providers, { id: "scripted-model", name: "Scripted model", ready: true }] }));
  ctx.on("llm:complete", (request) => {
    if (request.provider !== "scripted-model") return;
    const told = ["Quiet please", "Note stats", "Ask the page"].filter((name) => request.system.includes("- " + name + " ("));
    const code = request.system.includes("data:beforeWrite:learning\\", (change)") ? "with its code" : "without code";
    return { text: "Told about " + told.join(", ") + ", " + code + ". You asked: " + request.messages[0].content, stop: "end", model: "scripted-1", usage: { input: 120, output: 12 } };
  });
};`;

export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  watchErrors(page, errors, "ask");
  await page.goto(URL);
  const ask = '[data-key^="ask-the-page@"]';
  const seen = (selector, timeout = 8000) => page.waitForSelector(selector, { state: "attached", timeout }).then(() => true, () => false);

  const linked = await page.waitForFunction((s) => document.querySelectorAll(`${s} select option`).length >= 4, ask, { timeout: 10000 }).then(() => true, () => false);
  check("Ask the page lists the language models the homepage links", linked && (await seen(`${ask} option[value="llm-anthropic"]`, 1000)) && (await seen('[data-key^="chapter-6-models:"]', 1000)));

  await page.evaluate((data) => window.__host.command("user:add", { app: "root", files: [{ name: "scripted-model.js", data }] }), MODEL);
  await page.evaluate(() => window.__host.command("user:on", { app: "root", id: "scripted-model" }));
  await page.waitForSelector(`${ask} option[value="scripted-model"]`, { state: "attached", timeout: 8000 });
  await page.selectOption(`${ask} select`, "scripted-model");

  await page.fill(`${ask} input[name="question"]`, "How does Quiet please stop a note?");
  await page.click(`${ask} button[type="submit"]`);
  const answered = await seen(`${ask} .answer >> text=Told about Quiet please, Note stats, Ask the page, with its code`);
  check("Ask the page tells the model about every plugin, and sends the code of the one the question names", answered, (await page.textContent(`${ask} .answer`).catch(() => "")) ?? "");
  check("the answer says which model answered and what it cost", await seen(`${ask} .about-answer >> text=Answered by Scripted model, scripted-1 · 120 in, 12 out tokens`, 2000));
  const sent = await page.textContent(`${ask} .sent pre`).catch(() => "");
  check("what was sent to the model is shown under the answer, the question included", /The plugins on this page/.test(sent) && /Quiet please \(quiet-please\)/.test(sent) && /You:\nHow does Quiet please stop a note\?/.test(sent));

  await page.click(`${ask} button[data-action="suggest:0"]`);
  check("a suggested question asks it", await seen(`${ask} .answer >> text=You asked: What does each plugin on this page do?`));
  check("a question that names no plugin sends no code", await seen(`${ask} .answer >> text=without code`, 2000));

  // Switched off, the model leaves the picker; switched on again, it comes back once it is listening.
  const toggle = 'slot[name="switchboard"] input[data-action="switch:scripted-model"]';
  await page.click(toggle);
  const left = await page.waitForSelector(`${ask} option[value="scripted-model"]`, { state: "detached", timeout: 8000 }).then(() => true, () => false);
  await page.click(toggle);
  check("a model switched off leaves the picker, and comes back when it is switched on", left && (await seen(`${ask} option[value="scripted-model"]`)));
  await own.close();
}
