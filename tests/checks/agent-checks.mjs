// Agents that check things before they happen (`- check:` in an agent file):
// the security demo's agent is asked before a book is saved and before
// another agent calls a tool, and may block either. A scripted model, added
// as the person's own plugin for that app, stands in for both agents' model.

const APP = "demos/security";

/** The scripted model: the security agent's answers, and the librarian's. Sent as a plugin's source. */
function model(ctx) {
  ctx.on("llm:providers", (value) => ({ providers: [...value.providers, { id: "fake-model", name: "Scripted model", ready: true }] }));
  ctx.on("llm:complete", async (request) => {
    if (request.provider !== "fake-model") return;
    const last = request.messages.at(-1);
    const first = String(request.messages[0].content);
    const usage = { input: 10, output: 2 };
    const call = (name, args) => ({ text: "", toolCalls: [{ id: "c1", name, args }], stop: "tool", usage });
    ctx.log("model-asked " + JSON.stringify({ system: request.system.slice(0, 40), first: first.slice(0, 300), tools: request.tools.map((t) => t.name).sort() }));
    if (last.role === "tool") return { text: "Done.", stop: "end", usage };
    if (request.system.startsWith("You keep a reading list safe")) {
      if (first.includes("4111")) {
        // Slow enough for the board to show the save waiting.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return call("block", { reason: "The author field holds what looks like a card number" });
      }
      if (first.includes("5555")) return { text: "I can't tell.", stop: "end", usage };
      if (first.includes("6011")) {
        // Too slow: the write has gone on without it by the time it answers.
        await new Promise((resolve) => setTimeout(resolve, 17000));
        return call("data_list_library", {});
      }
      if (first.includes('"tool": "data_delete_library"')) return call("block", { reason: "Agents may not delete books" });
      return call("allow", {});
    }
    const json = /```json\n([^]*?)\n```/.exec(last.content);
    const book = json && JSON.parse(json[1])?.after;
    if (book?.title === "Middlemarch" && !book.author) return call("data_put_library", { record: { id: book.id, title: book.title, shelf: book.shelf, author: "George Eliot", year: 1871 }, reason: "Added the author and year" });
    if (book?.title === "Burn after reading") return call("data_delete_library", { id: book.id, reason: "Burn it" });
    return { text: "Nothing to do.", stop: "end", usage };
  });
}
const MODEL = `export const manifest = { id: "fake-model", name: "Scripted model", permissions: ["provide:llm"] };\nexport default ${model.toString()};`;

export default async function ({ a, check, openTab, URL, plugin, pluginLog }) {
  const page = await openTab(`${URL}${APP}/app.html`);
  const asked = () => a.evaluate(() => window.__host.traces.filter((e) => e.plugin === "fake-model" && e.detail?.startsWith("model-asked")).map((e) => JSON.parse(e.detail.slice(12))));
  const activity = () => page.textContent('[data-key="agent-activity:activity"]').catch(() => "");
  const form = '[data-key="library:books"] ui-form';
  const add = async (title, author = "") => {
    await page.fill(`${form} input[name="title"]`, title);
    await page.fill(`${form} input[name="author"]`, author);
    await page.click(`${form} button[type="submit"]`);
  };
  const formSays = (text, timeout = 10000) => page.waitForFunction(([sel, t]) => document.querySelector(sel)?.shadowRoot?.textContent.includes(t) ?? document.querySelector(sel)?.textContent.includes(t), [form, text], { timeout }).then(() => true, () => false);
  const tableHas = (text, timeout = 8000) => page.waitForSelector(`[data-key="library:books"] ui-table >> text=${text}`, { timeout }).then(() => true, () => false);
  try {
    await page.waitForSelector(form, { timeout: 8000 });
    await page.evaluate((data) => window.__host.command("user:add", { app: "demos/security", files: [{ name: "fake-model.js", data }] }), MODEL);
    await page.evaluate(() => window.__host.command("user:on", { app: "demos/security", id: "fake-model" }));

    // A card number in a book's author field: the save waits while the security agent checks it, then is refused.
    await add("Card test", "4111 1111 1111 1111");
    const waiting = await page.waitForSelector('[data-key^="board@"] >> text=Being checked by', { timeout: 8000 }).then(() => true, () => false);
    check("while an agent checks a write, the board shows it waiting", waiting);
    check("an agent that checks data:beforeWrite can block a write, and its reason is shown", await formSays("The author field holds what looks like a card number"));
    // The kernel's trace keeps only the latest entries, so calls are found by what they were asked, not by position.
    const first = (await asked()).find((c) => c.system.startsWith("You keep a reading list safe") && c.first.includes("Card test"));
    check("a check offers the model allow and block beside the agent's own tools", !!first && first.tools.includes("allow") && first.tools.includes("block") && first.tools.includes("data_list_library"), JSON.stringify(first?.tools));
    check("a blocked write isn't saved", !(await tableHas("Card test", 1000)));

    // An agent that ends without answering is unsure, and `if-unsure: block` stops the write.
    await add("Unsure test", "5555 5555 5555 4444");
    check("with if-unsure: block, a check the agent didn't answer blocks the write", await formSays("Security couldn't check it: it gave no answer"));

    // An agent that takes longer than the hook's agentTimeoutMs: with if-unsure: block the write is refused,
    // the kernel ends the run, and what the model asks for afterwards doesn't run.
    await add("Slow test", "6011 0000 0000 0004");
    check("a check past the hook's agentTimeoutMs blocks, with if-unsure: block", await formSays("could not answer data:beforeWrite:library", 20000));
    await page.waitForFunction(() => document.querySelector('[data-key="agent-activity:activity"]')?.textContent.includes("timeout"), null, { timeout: 5000 }).catch(() => {});
    check("the kernel ends a check that ran out of time", /timeout\s*security/.test(await activity()), (await activity()).replace(/\s+/g, " ").slice(0, 200));

    // No long run of digits: `when` doesn't match, so the security agent isn't asked about the write.
    // The librarian wakes and fills it in; the security agent is asked about that tool call first, and allows it.
    await add("Middlemarch");
    await page.waitForSelector('[data-key^="review:"] >> text=Librarian', { timeout: 10000 }).catch(() => {});
    await page.click('[data-key^="review:"] >> text=Accept').catch(() => {});
    check("a check allows another agent's tool call, which then lands", await tableHas("George Eliot"));
    // The trace reaches a tab in batches, up to a tenth of a second after the call it records: wait for the ask.
    await a.waitForFunction(() => window.__host.traces.some((e) => e.plugin === "fake-model" && e.detail?.startsWith("model-asked") && e.detail.includes("Middlemarch") && e.detail.includes("agent:beforeTool")), null, { timeout: 3000 }).catch(() => {});
    const security = (await asked()).filter((c) => c.system.startsWith("You keep a reading list safe") && c.first.includes("Middlemarch"));
    check(
      "a check with `when` isn't woken by a value that doesn't match",
      security.some((c) => c.first.includes("agent:beforeTool")) && !security.some((c) => c.first.includes("data:beforeWrite")),
      JSON.stringify(security.map((c) => c.first.slice(0, 50))),
    );

    // The librarian tries to delete a book: the security agent blocks the tool call, and the book stays.
    await add("Burn after reading");
    await page.waitForFunction(() => document.querySelector('[data-key="agent-activity:activity"]')?.textContent.includes("data_delete_library, which failed"), null, { timeout: 10000 }).catch(() => {});
    check("an agent that checks agent:beforeTool can block another agent's tool call", /librarian called data_delete_library, which failed/.test(await activity()) && (await tableHas("Burn after reading", 2000)), (await activity()).replace(/\s+/g, " ").slice(0, 300));
    check("agent:done says how a check ended", /block\s*security/.test(await activity()) && /allow\s*security/.test(await activity()));
    check("a check's model can't call tools once its time is up", !/security called data_list_library/.test(await activity()));

    // agent:beforeTool carries the tool's arguments, so hearing it needs hook:intercept, not hook:listen:agent:*.
    await plugin(`export const manifest = { id: "tool-snoop", name: "Tool snoop", permissions: ["hook:listen:agent:*"] };
export default (ctx) => { ctx.on("agent:beforeTool", () => {}); ctx.log("snoop-ready"); };`);
    await pluginLog("tool-snoop", "snoop-ready").catch(() => {});
    check("listening to agent:beforeTool needs hook:intercept:agent:beforeTool", await a.evaluate(() => window.__host.traces.some((e) => e.kind === "denied" && e.plugin === "tool-snoop" && e.name === "hook:intercept:agent:beforeTool")));
    await a.evaluate(() => window.__host.command("uninstall", "tool-snoop"));
  } finally {
    await page.evaluate(() => window.__host.command("user:remove", { app: "demos/security", id: "fake-model" })).catch(() => {});
    await page.close({ runBeforeUnload: true });
  }
}
