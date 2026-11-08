// Agents (src/kernel/agents/, src/kernel/services/agents.ts): a Markdown file
// an app links with rel="agent", run by the kernel as a plugin that asks a
// model and calls its tools. The librarian demo links one. A scripted model,
// added as the person's own plugin for that app, stands in for a real one, so
// the test covers the whole loop: the hook wakes the agent, the model picks a
// tool, the change is reviewed, the app hears the agent:* events, and the
// agent's own write doesn't wake it again.

const APP = "demos/librarian";

/** A model that knows one book: it fills in Middlemarch, spends a lot when told to, and otherwise has nothing to do. */
const MODEL = `export const manifest = { id: "fake-model", name: "Scripted model", permissions: ["provide:llm"] };
export default (ctx) => {
  ctx.on("llm:providers", (value) => ({ providers: [...value.providers, { id: "fake-model", name: "Scripted model", ready: true }] }));
  ctx.on("llm:complete", (request) => {
    if (request.provider !== "fake-model") return;
    const last = request.messages.at(-1);
    ctx.log("model-asked " + JSON.stringify({ last: last.role, tools: request.tools.map((t) => t.name).sort(), system: request.system.slice(0, 40) }));
    if (last.role === "tool") return { text: "Filled in Middlemarch.", stop: "end", usage: { input: 30, output: 5 } };
    if (last.content.includes("spend")) return { text: "Spent.", stop: "end", usage: { input: 250000, output: 1 } };
    const json = /\`\`\`json\\n([^]*?)\\n\`\`\`/.exec(last.content);
    const book = json && JSON.parse(json[1])?.after;
    if (book?.title === "Middlemarch" && !book.author)
      return { text: "", toolCalls: [{ id: "c1", name: "data_put_library", args: { record: { id: book.id, title: book.title, shelf: book.shelf, author: "George Eliot", year: 1871 }, reason: "Added the author and year of Middlemarch" } }], stop: "tool", usage: { input: 20, output: 10 } };
    return { text: "Nothing to do.", stop: "end", usage: { input: 5, output: 2 } };
  });
};`;

export default async function ({ a, check, openTab, URL, plugin, pluginLog }) {
  const page = await openTab(`${URL}${APP}/app.html`);
  const asked = () => a.evaluate(() => window.__host.traces.filter((e) => e.plugin === "fake-model" && e.detail?.startsWith("model-asked")).map((e) => JSON.parse(e.detail.slice(12))));
  const activity = () => page.textContent('[data-key="agent-activity:activity"]').catch(() => "");
  try {
    await page.waitForSelector('[data-key="library:books"]', { timeout: 8000 });
    await page.evaluate((data) => window.__host.command("user:add", { app: "demos/librarian", files: [{ name: "fake-model.js", data }] }), MODEL);
    await page.evaluate(() => window.__host.command("user:on", { app: "demos/librarian", id: "fake-model" }));
    const before = (await asked()).length;

    // The person adds a book with only its title: the agent wakes, the model asks to fill it in, the person reviews it.
    await page.fill('[data-key="library:books"] ui-form input[name="title"]', "Middlemarch");
    await page.click('[data-key="library:books"] ui-form button[type="submit"]');
    const card = await page.waitForSelector('[data-key^="review:"] >> text=Librarian', { timeout: 10000 }).then(() => true, () => false);
    check("an agent linked with rel=\"agent\" wakes on its hook and asks to change a collection it doesn't own, through review", card);
    await page.click('[data-key^="review:"] >> text=Accept').catch(() => {});
    const filled = await page.waitForSelector('[data-key="library:books"] ui-table >> text=George Eliot', { timeout: 8000 }).then(() => true, () => false);
    check("the agent's tool call lands once the person accepts it", filled);
    await page.waitForFunction(() => document.querySelector('[data-key="agent-activity:activity"]')?.textContent.includes("Filled in Middlemarch"), null, { timeout: 8000 }).catch(() => {});
    const log = await activity();
    check("the app hears agent:wake, agent:toolResult and agent:done", /woke\s*librarian: data:changed:library/.test(log) && /librarian called data_put_library/.test(log) && /Filled in Middlemarch\. \(65 tokens\)/.test(log), log.replace(/\s+/g, " ").slice(0, 300));

    // Give an echo time to arrive: the agent's own write must not wake it again.
    await page.waitForTimeout(1500);
    const calls = (await asked()).slice(before);
    check("an agent isn't woken by its own write", calls.length === 2, JSON.stringify(calls.map((c) => c.last)));
    const [first] = calls;
    check(
      "the agent's instructions are the system prompt, and its tools are what its manifest grants",
      first?.system.startsWith("You look after a reading list") && first.tools.includes("data_put_library") && first.tools.includes("data_list_library") && !first.tools.some((t) => /^(llm|tools|agents)_/.test(t)),
      JSON.stringify(first?.tools),
    );

    // Commands: a plugin with agents:run:librarian may start one; the kernel counts tokens and stops the agent at its limit.
    await plugin(`export const manifest = { id: "agent-caller", name: "Agent caller", permissions: ["agents:run:librarian", "hook:listen:agent:*"] };
export default async (ctx) => {
  const tryIt = (p) => p.then((v) => JSON.stringify(v), (e) => "error: " + e.message);
  ctx.on("agent:done", (e) => ctx.log("caller-done " + e.stopReason + " " + e.text));
  ctx.on("agent:budget", (e) => ctx.log("caller-budget " + JSON.stringify(e)));
  try { ctx.on("agent:run", () => {}); } catch {}
  ctx.log("caller-unknown " + await tryIt(ctx.call("agents", "run", "librarian", "burn-it-down")));
  ctx.log("caller-other " + await tryIt(ctx.call("agents", "run", "someone-else", "fill-missing")));
  ctx.log("caller-inner " + await tryIt(ctx.call("agents", "begin", { kind: "command" })));
  ctx.log("caller-run " + await tryIt(ctx.call("agents", "run", "librarian", "fill-missing", { note: "spend" })));
};`);
    check("only an agent's own commands can be run, by a plugin with agents:run:<agent>", /error: Librarian has no command burn-it-down/.test(await pluginLog("agent-caller", "caller-unknown").catch(() => "")) && /error: .*agents:run:someone-else/.test(await pluginLog("agent-caller", "caller-other").catch(() => "")));
    check("the agent loop's own methods are only for agents", /error: agents.begin is for agents/.test(await pluginLog("agent-caller", "caller-inner").catch(() => "")));
    check("a command runs the agent", (await pluginLog("agent-caller", "caller-done").catch(() => "")) === "caller-done completed Spent.");
    check("only agents hear agent:run", await a.evaluate(() => window.__host.traces.some((e) => e.kind === "denied" && e.plugin === "agent-caller" && e.name === "agent")));
    await a.evaluate(() => window.__host.command("uninstall", "agent-caller"));

    await plugin(`export const manifest = { id: "agent-caller-2", name: "Agent caller", permissions: ["agents:run:librarian", "hook:listen:agent:*"] };
export default async (ctx) => {
  ctx.on("agent:budget", (e) => ctx.log("again-budget " + e.limit + " " + (e.used >= e.max)));
  await ctx.call("agents", "run", "librarian", "fill-missing");
  const [agent] = await ctx.call("agents", "list");
  ctx.log("again-list " + JSON.stringify({ id: agent?.id, commands: agent?.commands, over: agent?.used.tokens >= agent?.limits.tokensPerDay }));
};`);
    check("past its tokens a day, an agent doesn't run, and the app hears agent:budget", (await pluginLog("agent-caller-2", "again-budget").catch(() => "")) === "again-budget tokens-per-day true");
    check("agents.list says what each agent is woken by and what it has used", (await pluginLog("agent-caller-2", "again-list").catch(() => "")) === 'again-list {"id":"librarian","commands":["fill-missing"],"over":true}');
    await page.waitForFunction(() => document.querySelector('[data-key="agent-activity:activity"]')?.textContent.includes("tokens-per-day"), null, { timeout: 5000 }).catch(() => {});
    check("the activity list shows the limit", /reached its tokens-per-day limit/.test(await activity()));
  } finally {
    await a.evaluate(() => window.__host.command("uninstall", "agent-caller-2")).catch(() => {});
    await page.evaluate(() => window.__host.command("user:remove", { app: "demos/librarian", id: "fake-model" })).catch(() => {});
    await page.close({ runBeforeUnload: true });
  }
}
