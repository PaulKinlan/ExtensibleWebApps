// The standard agents (std/agents/): the assistant does what the person asks
// with the app's commands, and the builder writes a plugin, saved through a
// review, acting for the person once they let it (acts-as: person). Both are
// reached through the chat plugin. A scripted model, added as the person's
// own plugin for the app, stands in for theirs.

const APP = "demos/assistant";

/** The scripted model: the assistant's turns and the builder's. Sent as a plugin's source. */
function model(ctx) {
  const PLUGIN = [
    'export const manifest = { id: "finished-count", name: "Finished count", description: "Says how many books are done.", version: "1.0.0", permissions: ["ui"] };',
    'export default function (ctx) { ctx.ui.render("main", "count", ctx.ui.html`<ui-card><p>Built by the builder</p></ui-card>`); }',
  ].join("\n");
  ctx.on("llm:providers", (value) => ({ providers: [...value.providers, { id: "fake-model", name: "Scripted model", ready: true }] }));
  ctx.on("llm:complete", async (request) => {
    if (request.provider !== "fake-model") return;
    const last = request.messages.at(-1);
    const first = String(request.messages[0].content);
    const usage = { input: 10, output: 2 };
    const call = (name, args) => ({ text: "", toolCalls: [{ id: `c${request.messages.length}`, name, args }], stop: "tool", usage });
    ctx.log("model-asked " + JSON.stringify({ system: request.system.slice(0, 40), first: first.slice(0, 1500), tools: request.tools.map((t) => t.name).sort(), last: last.role === "tool" ? { name: last.name, content: String(last.content).slice(0, 300) } : null }));
    if (request.system.startsWith("You help the person use this app")) {
      if (!last.name) return call("commands_list", {});
      if (last.name === "commands_list") return call("commands_run", { name: "library/add", args: { title: "Piranesi", author: "Susanna Clarke" } });
      return { text: `Added it. The command said: ${last.content}`, stop: "end", usage };
    }
    if (request.system.startsWith("You write plugins for this app")) {
      if (!last.name) return call("authoring_check", { code: PLUGIN });
      if (last.name === "authoring_check") return call("authoring_save", { code: PLUGIN });
      return { text: `Saving answered: ${last.content}`, stop: "end", usage };
    }
    return { text: "Nothing to do.", stop: "end", usage };
  });
}
const MODEL = `export const manifest = { id: "fake-model", name: "Scripted model", permissions: ["provide:llm"] };\nexport default ${model.toString()};`;

export default async function ({ a, check, openTab, URL }) {
  const page = await openTab(`${URL}${APP}/app.html`);
  const chat = '[data-key^="chat@"]';
  const review = '[data-key^="review:"]';
  const asked = () => a.evaluate(() => window.__host.traces.filter((e) => e.plugin === "fake-model" && e.detail?.startsWith("model-asked")).map((e) => JSON.parse(e.detail.slice(12))));
  /** The first model call that `test` (a function's source, run in the page) picks, waiting for its trace to arrive. */
  const turnWhere = (test) =>
    a.waitForFunction((t) => window.__host.traces.filter((e) => e.plugin === "fake-model" && e.detail?.startsWith("model-asked")).map((e) => JSON.parse(e.detail.slice(12))).find(eval(t)), test, { timeout: 5000 }).then((h) => h.jsonValue(), () => undefined);
  const seen = (selector, timeout = 10000) => page.waitForSelector(selector, { timeout }).then(() => true, () => false);
  const chatSays = (text, timeout = 15000) => seen(`${chat} >> text=${text}`, timeout);
  const send = async (agent, text) => {
    await page.selectOption(`${chat} select`, agent);
    await page.fill(`${chat} input[name="text"]`, text);
    await page.click(`${chat} button[type="submit"]`);
  };
  const changes = () => page.evaluate(() => window.__host.command("changes"));
  try {
    await page.waitForSelector('[data-key="library:books"] ui-form', { timeout: 8000 });
    await page.evaluate((data) => window.__host.command("user:add", { app: "demos/assistant", files: [{ name: "fake-model.js", data }] }), MODEL);
    await page.evaluate(() => window.__host.command("user:on", { app: "demos/assistant", id: "fake-model" }));

    const listed = await page.waitForFunction((s) => [...document.querySelectorAll(`${s} select option`)].map((o) => o.value).sort().join() === "assistant,builder", chat, { timeout: 10000 }).then(() => true, () => false);
    check("the chat lists the app's agents that have an inbox", listed);

    // The assistant: the app's commands are its tools.
    await send("assistant", "Add Piranesi by Susanna Clarke");
    check("the assistant answers in the chat", await chatSays("Added it"));
    check("the assistant does it with the app's own commands", await seen('[data-key="library:books"] ui-table >> text=Piranesi', 5000));
    const turn = await turnWhere(`(c) => c.system.startsWith("You help the person use this app")`);
    check("the assistant's tools are the commands tools and bus_ask", !!turn && ["bus_ask", "commands_list", "commands_run"].every((t) => turn.tools.includes(t)) && !turn.tools.some((t) => /^data_(list|get|put|delete)/.test(t)), JSON.stringify(turn?.tools ?? (await asked()).map((c) => c.system)));

    // The builder, run 1: the person lets it act for them this time. Its save is still reviewed, as theirs.
    await send("builder", "A card that says how many books I've finished");
    check("an agent with acts-as: person asks the person first", await seen(`${review} >> text=Let Builder act for you?`));
    await page.click(`${review} >> text="This time"`);
    check("acting for the person, its save is still reviewed, and the card says so", await seen(`${review} >> text=Builder, acting for you, wants to change your plugins: adds Finished count`));
    await page.click(`${review} >> text="Accept"`);
    check("the plugin the builder saved runs", await seen(`[data-key="finished-count:count"] >> text=Built by the builder`));
    const answered = await chatSays("Saving answered");
    if (!answered && process.env.DEBUG_PRESETS) console.log(JSON.stringify((await a.evaluate(() => window.__host.traces.filter((e) => /builder|chat|bus\.|agent:|change:|review/.test(`${e.plugin} ${e.name}`)).slice(-60).map((e) => `${e.kind} ${e.name} ${e.plugin ?? ""} ${e.detail ?? ""}`))), null, 1), JSON.stringify(await changes()));
    check("the builder answers in the chat", answered);
    const builderTurn = await turnWhere(`(c) => c.system.startsWith("You write plugins for this app")`);
    check("the builder's tools are the authoring tools, not the data", !!builderTurn && ["authoring_check", "authoring_save", "authoring_source", "authoring_mine"].every((t) => builderTurn.tools.includes(t)) && !builderTurn.tools.some((t) => /^data_(list|get|put|delete)/.test(t)), JSON.stringify(builderTurn?.tools));
    const saved = (await changes()).filter((e) => e.kind === "write" && e.plugin === "builder");
    check("the change log has the save as the person's, made through the builder", saved.at(-1)?.as === "person" && saved.at(-1)?.outcome === "allowed-once", JSON.stringify(saved.at(-1)));

    // Run 2: "Not now": it acts as itself, and the review says so.
    await send("builder", "Change it to say something else");
    await page.waitForSelector(`${review} >> text=Let Builder act for you?`, { timeout: 10000 });
    await page.click(`${review} >> text="Not now"`);
    check("declined, the agent acts as itself", await seen(`${review} >> text=Builder wants to change your plugins`));
    await page.click(`${review} >> text="Decline"`);
    await chatSays("Not saved");
    const followUp = await turnWhere(`(c) => c.first.includes("Change it to say")`);
    check("the chat sends the conversation so far with that agent, and only that one", !!followUp && followUp.first.includes('"conversation"') && followUp.first.includes("Saving answered") && !followUp.first.includes("Add Piranesi"), followUp?.first);
    const declined = (await changes()).filter((e) => e.kind === "write" && e.plugin === "builder").at(-1);
    check("a change it made as itself isn't logged as the person's", declined?.outcome === "rejected" && !declined.as, JSON.stringify(declined));

    // Run 3: "Always", which is kept, so run 4 doesn't ask.
    await send("builder", "Try again");
    await page.waitForSelector(`${review} >> text=Let Builder act for you?`, { timeout: 10000 });
    await page.click(`${review} >> text="Always"`);
    await page.waitForSelector(`${review} >> text=Builder, acting for you`, { timeout: 10000 });
    await page.click(`${review} >> text="Decline"`);
    check("letting it always act for you is kept as a grant", (await changes()).some((e) => e.kind === "grant" && e.plugin === "builder" && e.detail === "acting for you"));
    await send("builder", "Once more");
    const straight = await seen(`${review} >> text=Builder, acting for you`);
    check("once always allowed, it acts for you without asking again", straight && !(await page.$(`${review} >> text=Let Builder act for you?`)));
    await page.click(`${review} >> text="Decline"`);
  } finally {
    await page.evaluate(() => window.__host.command("user:remove", { app: "demos/assistant", id: "fake-model" })).catch(() => {});
    await page.evaluate(() => window.__host.command("user:remove", { app: "demos/assistant", id: "finished-count" })).catch(() => {});
    await page.close();
  }
}
