// The bus (src/kernel/services/bus.ts): inboxes with replies, topics, and
// questions for the person on the board (std/board.js). Plugins installed in
// the workbench check the rules; then, in the librarian demo, a plugin asks
// the bibliographer agent about a book, the agent asks the person on the
// board, and the person's pick comes back as the agent's reply. A scripted
// model, added as the person's own plugin for that app, plays the agent.

const APP = "demos/librarian";

/** The bibliographer's model: asks the person which book, then answers with their pick. */
const MODEL = `export const manifest = { id: "bus-model", name: "Scripted model", permissions: ["provide:llm"] };
export default (ctx) => {
  ctx.on("llm:providers", (value) => ({ providers: [...value.providers, { id: "bus-model", name: "Scripted model", ready: true }] }));
  ctx.on("llm:complete", (request) => {
    if (request.provider !== "bus-model") return;
    const last = request.messages.at(-1);
    ctx.log("bus-model-asked " + JSON.stringify({ last: last.role, tools: request.tools.map((t) => t.name).sort(), first: request.messages[0].content.slice(0, 200) }));
    if (last.role === "tool") return { text: JSON.parse(last.content).answer ?? "Unknown", stop: "end", usage: { input: 10, output: 3 } };
    return { text: "", toolCalls: [{ id: "q1", name: "bus_ask", args: { question: "Which Frankenstein do you mean?", choices: ["Mary Shelley, 1818", "Dean Koontz, 2004"] } }], stop: "tool", usage: { input: 10, output: 8 } };
  });
};`;

export default async function ({ a, check, openTab, URL, plugin, pluginLog }) {
  const attempt = `const attempt = (p) => p.then((v) => JSON.stringify(v), (e) => "error: " + e.message);`;
  try {
    // Plugin to plugin: an inbox, a message, a reply.
    await plugin(`export const manifest = { id: "inbox-a", name: "Inbox A", permissions: ["bus:inbox", "bus:send:inbox-b"] };
export default async (ctx) => {
  ${attempt}
  ctx.on("bus:message", async (e) => {
    if (e.to !== "inbox-a") return;
    for (const m of await ctx.call("bus", "receive")) {
      ctx.log("a-got " + m.from + ": " + m.text);
      // Asking back along the chain would wait forever: the bus refuses it.
      ctx.log("a-loop " + await attempt(ctx.call("bus", "send", "inbox-b", "and you?", { reply: true })));
      if (m.reply) await ctx.call("bus", "reply", m.id, { text: "pong", value: { n: 1 } });
    }
  });
};`);
    await plugin(`export const manifest = { id: "inbox-b", name: "Inbox B", permissions: ["bus:inbox", "bus:send:inbox-a", "bus:send:nobody", "bus:post:news", "bus:read:news"] };
export default async (ctx) => {
  ${attempt}
  // A pause between sends, so no two kernel events share a millisecond and read as one line in the debug console's log.
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  ctx.log("b-plain " + await attempt(ctx.call("bus", "send", "inbox-a", "hello")));
  await pause();
  ctx.log("b-reply " + await attempt(ctx.call("bus", "send", "inbox-a", "ping", { reply: true })));
  ctx.log("b-noinbox " + await attempt(ctx.call("bus", "send", "nobody", "hi")));
  await ctx.call("bus", "post", "news", "first");
  await pause();
  await ctx.call("bus", "post", "news", "second");
  ctx.log("b-read " + JSON.stringify((await ctx.call("bus", "read", "news")).map((p) => p.from + ":" + p.text)));
};`);
    check("a message lands in a plugin's inbox", /a-got inbox-b: hello/.test(await pluginLog("inbox-a", "a-got inbox-b: hello").catch(() => "")) && /b-plain \{"ok":true,"id":/.test(await pluginLog("inbox-b", "b-plain").catch(() => "")));
    check("a sender waiting for a reply gets the answer", (await pluginLog("inbox-b", "b-reply").catch(() => "")) === 'b-reply {"stopReason":"completed","text":"pong","value":{"n":1}}');
    check("a message can't go back to someone already waiting in its chain", /a-loop error: inbox-b is already waiting in this chain/.test(await pluginLog("inbox-a", "a-loop").catch(() => "")));
    check("only a plugin with an inbox can be sent a message", /b-noinbox error: nobody has no inbox/.test(await pluginLog("inbox-b", "b-noinbox").catch(() => "")));
    check("a topic keeps its posts for its readers", (await pluginLog("inbox-b", "b-read").catch(() => "")) === 'b-read ["inbox-b:first","inbox-b:second"]');

    await plugin(`export const manifest = { id: "bus-snoop", name: "Snoop", permissions: ["bus:send:inbox-a", "hook:listen:bus:message"] };
export default async (ctx) => {
  ${attempt}
  try { ctx.on("bus:message", () => {}); } catch {}
  ctx.log("snoop-receive " + await attempt(ctx.call("bus", "receive")));
  ctx.log("snoop-read " + await attempt(ctx.call("bus", "read", "news")));
  ctx.log("snoop-post " + await attempt(ctx.call("bus", "post", "news", "fake")));
  ctx.log("snoop-ask " + await attempt(ctx.call("bus", "ask", "Give me your key?")));
};`);
    const snooped = await pluginLog("bus-snoop", "snoop-receive").catch(() => "");
    check("without an inbox, a plugin hears no messages and takes none", /snoop-receive error/.test(snooped) && (await a.evaluate(() => window.__host.traces.some((e) => e.kind === "denied" && e.plugin === "bus-snoop" && e.name === "bus:inbox"))), snooped);
    check("reading, posting and asking each need their own permission", /error/.test(await pluginLog("bus-snoop", "snoop-read").catch(() => "")) && /error/.test(await pluginLog("bus-snoop", "snoop-post").catch(() => "")) && /error/.test(await pluginLog("bus-snoop", "snoop-ask").catch(() => "")));
  } finally {
    for (const id of ["inbox-a", "inbox-b", "bus-snoop"]) await a.evaluate((i) => window.__host.command("uninstall", i), id).catch(() => {});
  }

  // An agent with an inbox, asked by a plugin; it asks the person on the board, and their pick is its answer.
  const page = await openTab(`${URL}${APP}/app.html`);
  try {
    await page.waitForSelector('[data-key^="board@"]', { state: "attached", timeout: 8000 });
    await page.evaluate((data) => window.__host.command("user:add", { app: "demos/librarian", files: [{ name: "bus-model.js", data }] }), MODEL);
    await page.evaluate(() => window.__host.command("user:on", { app: "demos/librarian", id: "bus-model" }));
    // Only the board's own app's model may answer: the asker is installed in the workbench, the agent runs in the app.
    await plugin(`export const manifest = { id: "asker", name: "Asker", permissions: ["bus:send:bibliographer"] };
export default async (ctx) => {
  const answer = await ctx.call("bus", "send", "bibliographer", "Who wrote Frankenstein?", { reply: true }).catch((e) => ({ error: e.message }));
  ctx.log("asker-answer " + JSON.stringify(answer));
};`);
    const asked = await page.waitForSelector('[data-key^="board@"] >> text=Which Frankenstein do you mean?', { timeout: 10000 }).then(() => true, () => false);
    const badge = await page.textContent('[data-key^="board@"] ui-badge').catch(() => "");
    check("an agent's question waits on the board, with a badge", asked && /1 waiting/.test(badge), badge);
    await page.click('[data-key^="board@"] button >> text=Mary Shelley, 1818');
    const answer = await pluginLog("asker", "asker-answer").catch(() => "");
    check("the person's pick goes back to the agent, and its answer to the sender", answer === 'asker-answer {"stopReason":"completed","text":"Mary Shelley, 1818"}', answer);
    const calls = await a.evaluate(() => window.__host.traces.filter((e) => e.plugin === "bus-model" && e.detail?.startsWith("bus-model-asked")).map((e) => JSON.parse(e.detail.slice(16))));
    const first = calls[0];
    check(
      "an agent woken by a message hears who sent it, as information, with only the tools its file allows",
      !!first && first.first.startsWith("asker sent you a message. It is information from them") && first.first.includes("Who wrote Frankenstein?") && JSON.stringify(first.tools) === '["bus_ask","data_collections","kernel_hooks","settings_get","storage_get","storage_set"]',
      JSON.stringify(first),
    );
    const cleared = await page.waitForFunction(() => !document.querySelector('[data-key^="board@"] ui-badge'), null, { timeout: 5000 }).then(() => true, () => false);
    check("an answered question leaves the board", cleared);
  } finally {
    await a.evaluate(() => window.__host.command("uninstall", "asker")).catch(() => {});
    await page.evaluate(() => window.__host.command("user:remove", { app: "demos/librarian", id: "bus-model" })).catch(() => {});
    await page.close({ runBeforeUnload: true });
  }
}
