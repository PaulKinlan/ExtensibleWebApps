// A person adds an agent of their own to an app that links none: an
// .agent.md file, pasted into Customize or from an address on the site, is
// reviewed like a plugin, kept with their plugins (src/kernel/user-plugins.ts)
// and runs the site's standard agent loop. Chat, from the registry, is where
// they write to it. A scripted model stands in for a vendor.
//
// It runs in a browser context of its own, on the contacts demo.

import { watchErrors } from "../page-errors.mjs";

const MODEL = `export const manifest = { id: "own-agents-model", name: "Scripted model", permissions: ["provide:llm"] };
export default (ctx) => {
  ctx.on("llm:providers", (value) => ({ providers: [...value.providers, { id: "own-agents-model", name: "Scripted model", ready: true }] }));
  ctx.on("llm:complete", (request) => {
    if (request.provider !== "own-agents-model") return undefined;
    return { text: "The helper heard: " + (request.messages[request.messages.length - 1].content.includes("hello there") ? "hello there" : "something else") + " / " + (request.system ?? "").includes("one short line"), stop: "end", model: "scripted", usage: { input: 1, output: 1 } };
  });
};`;

const AGENT = `---
id: my-helper
name: My helper
description: Answers what you write to it.
permissions: []
on:
  - message: true
---
You answer in one short line.
`;

export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  watchErrors(page, errors, "own-agents");
  const app = "demos/contacts";
  await page.goto(`${URL}${app}/app.html`);
  await page.waitForFunction(() => window.__host);
  const command = (name, args) => page.evaluate(([name, args]) => window.__host.command(name, args), [name, { app, ...args }]);
  const review = '[data-key^="review:"]';
  const accept = async (what) => {
    const shown = await page.waitForSelector(`${review} >> text=${what}`, { timeout: 15000 }).then(() => true, () => false);
    const text = shown ? ((await page.textContent(review)) ?? "") : "";
    await page.click(`${review} button:has-text("Accept")`, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector(review, { state: "detached", timeout: 10000 }).catch(() => {});
    return text;
  };
  const status = () => page.evaluate(() => document.querySelector("ui-panel [role=status]")?.textContent ?? "");
  const said = (pattern) => page.waitForFunction((source) => new RegExp(source).test(document.querySelector("ui-panel [role=status]")?.textContent ?? ""), pattern.source, { timeout: 20000 }).then(status, status);
  const row = (id) => page.evaluate((id) => [...document.querySelectorAll(".entry")].find((e) => e.querySelector(`[data-remove="${id}"]`))?.textContent.replace(/\s+/g, " ").trim() ?? "", id);
  const paste = async (text) => {
    await page.waitForSelector('form[data-action="paste"]', { state: "attached", timeout: 15000 });
    await page.evaluate(() => (document.querySelector('form[data-action="paste"]').closest("details").open = true));
    await page.fill('form[data-action="paste"] textarea', text);
    await page.click('form[data-action="paste"] button[type=submit]');
  };

  try {
    await command("user:add", { files: [{ name: "own-agents-model.js", data: MODEL }] });
    await command("user:on", { id: "own-agents-model" });
    await page.reload();
    await page.waitForFunction(() => window.__host);
    await page.click("ui-panel .launch");

    // Pasted: the review shows the agent file itself, and what the agent may do.
    await paste(AGENT);
    const card = await accept("adds My helper");
    await page.waitForSelector('[data-toggle="my-helper"]:has-text("Turn off")', { timeout: 15000 }).catch(() => {});
    const mine = await command("user:list", {});
    const kept = mine.find((p) => p.id === "my-helper");
    check("an agent file pasted into Customize is reviewed as written, then added as the person's own and turned on", /You answer in one short line\./.test(card) && /Work as an agent/.test(card) && /Get the messages written to it\./.test(card) && !!kept && kept.on && kept.file === "my-helper.agent.md", `${JSON.stringify(kept)} ${card.slice(0, 120)}`);
    const helper = await row("my-helper");
    check("Customize lists it as the person's agent", /My helper/.test(helper) && /Your agent/.test(helper) && /Answers what you write to it\./.test(helper), helper.slice(0, 200));

    // Chat, from the registry, is where the person writes to it.
    await page.click('[data-package="chat"]');
    await accept("adds Chat");
    const chat = '[data-key^="chat@"]';
    await page.waitForSelector(`${chat} select[data-action="agent"] option[value="my-helper"]`, { state: "attached", timeout: 15000 }).catch(() => {});
    await page.keyboard.press("Escape");
    await page.fill(`${chat} input[name="text"]`, "hello there");
    await page.click(`${chat} button[type=submit]`);
    const answered = await page.waitForSelector(`${chat} li >> text=The helper heard:`, { timeout: 30000 }).then(() => true, () => false);
    const answer = answered ? await page.textContent(`${chat} ol li:last-child`) : ((await page.textContent(chat).catch(() => "")) ?? "").slice(-300);
    check("the agent runs the standard loop with a model: Chat, added from the registry, writes to it and shows its answer", answered && /hello there/.test(answer) && /\/ true/.test(answer), answer);

    // From an address on the site.
    await page.click("ui-panel .launch");
    await page.waitForSelector('form[data-action="url"]', { state: "attached", timeout: 15000 });
    await page.evaluate(() => (document.querySelector('form[data-action="url"]').closest("details").open = true));
    await page.fill('form[data-action="url"] input', "/std/agents/assistant.agent.md");
    await page.click('form[data-action="url"] button[type=submit]');
    await accept("adds Assistant");
    await page.waitForSelector('[data-toggle="assistant"]:has-text("Turn off")', { timeout: 15000 }).catch(() => {});
    const assistant = (await command("user:list", {})).find((p) => p.id === "assistant");
    check("an agent on the site is added from its address", !!assistant && assistant.on && assistant.file === "assistant.agent.md", JSON.stringify(assistant));

    // What an app's author chooses, a person's agent can't: another loop, or a door for outside agents.
    await paste(AGENT.replace("id: my-helper", "id: other-loop\nrunner: ./mine.js"));
    const loop = await said(/standard agent loop/);
    await paste(AGENT.replace("id: my-helper", "id: a-door\noutside: true"));
    const door = await said(/outside agents/);
    const none = await page.locator(review).count();
    const after = await command("user:list", {});
    check("an agent that names its own loop, or opens the door to outside agents, is refused with the reason and no review", /standard agent loop/.test(loop) && /outside agents/.test(door) && none === 0 && !after.some((p) => p.id === "other-loop" || p.id === "a-door"), `${loop} | ${door}`);

    // Removed like a plugin.
    await page.click('[data-remove="my-helper"]');
    await accept("removes My helper");
    await said(/Removed My helper/);
    check("removing it takes its file away", !(await command("user:list", {})).some((p) => p.id === "my-helper"));
  } finally {
    for (const id of ["my-helper", "assistant", "chat", "own-agents-model", "other-loop", "a-door"]) await command("user:remove", { id }).catch(() => {});
    await own.close();
  }
}
