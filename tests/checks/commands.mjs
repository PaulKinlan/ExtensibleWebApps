// Commands (src/kernel/services/commands.ts, ctx.commands.add) and the command
// palette (std/commands/palette.js, elements/ui-commands.html): a plugin names
// what it does, and a palette, a shortcut or an agent's tool call runs it.

export default async function ({ a, check, plugin, pluginLog, openTab, URL }) {
  const ids = ["cmd-owner", "cmd-runner", "cmd-blind", "cmd-copycat", "cmd-guard"];
  try {
    await plugin(`export const manifest = { id: 'cmd-owner', name: 'Owner', permissions: [] };
export default (ctx) => {
  ctx.commands.add({ id: 'greet', title: 'Greet', keys: ['Mod+G'], args: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } }, ({ name }, { by }) => 'hello ' + name + ' from ' + by);
  ctx.commands.add({ id: 'fail', title: 'Fail' }, () => { throw new Error('boom'); });
  ctx.commands.add({ id: 'plain', title: 'Plain' }, () => 'ran');
  ctx.commands.add({ id: 'shape', title: 'Shape' }, () => ({ block: 'paragraph', failed: false }));
  const offOld = ctx.commands.add({ id: 'twice', title: 'Twice' }, () => 'old');
  ctx.commands.add({ id: 'twice', title: 'Twice again' }, () => 'new');
  offOld();
  ctx.commands.add({ id: 'Bad Id', title: 'Bad' }, () => {});
  ctx.commands.add({ id: 'bad-keys', title: 'Bad keys', keys: ['Hyper+K'] }, () => {});
  ctx.log('owner-ready');
};`);
    await pluginLog("cmd-owner", "owner-ready");
    // Listens for greet too, without adding it: the kernel names the hook after its own instance, so it never hears the owner's.
    await plugin(`export const manifest = { id: 'cmd-copycat', name: 'Copycat', permissions: [] };
export default (ctx) => { ctx.on('command:greet', () => 'copycat answered'); };`);
    await plugin(`export const manifest = { id: 'cmd-guard', name: 'Guard', permissions: ['hook:intercept:commands:before'] };
export default (ctx) => { ctx.on('commands:before', (run) => (run.name === 'cmd-owner/plain' && run.by === 'cmd-runner' ? { block: 'not for runners' } : undefined)); };`);
    await plugin(`export const manifest = { id: 'cmd-blind', name: 'Blind', permissions: [] };
export default async (ctx) => { ctx.log('blind ' + await ctx.call('commands', 'list').then(() => 'listed', (e) => e.message)); };`);
    await plugin(`export const manifest = { id: 'cmd-runner', name: 'Runner', permissions: ['commands'] };
export default async (ctx) => {
  const attempt = (...args) => ctx.call('commands', 'run', ...args).then((v) => JSON.stringify(v), (e) => 'error: ' + e.message);
  ctx.on('commands:ran', (ran) => ctx.log('ran ' + ran.name + ' ' + ran.ok));
  const list = await ctx.call('commands', 'list');
  ctx.log('list ' + JSON.stringify(list.filter((c) => c.plugin.startsWith('cmd-')).map((c) => c.name)));
  ctx.log('keys ' + JSON.stringify(list.find((c) => c.name === 'cmd-owner/greet')?.keys));
  ctx.log('greet ' + await attempt('cmd-owner/greet', { name: 'Ada' }));
  ctx.log('greet-missing ' + await attempt('cmd-owner/greet', {}));
  ctx.log('fail ' + await attempt('cmd-owner/fail'));
  ctx.log('plain ' + await attempt('cmd-owner/plain'));
  ctx.log('shape ' + await attempt('cmd-owner/shape'));
  ctx.log('twice ' + await attempt('cmd-owner/twice'));
  ctx.log('copycat ' + await attempt('cmd-copycat/greet'));
  const tools = await ctx.call('tools', 'list');
  ctx.log('tools ' + JSON.stringify(tools.filter((t) => t.service === 'commands').map((t) => t.name)));
  ctx.log('tool ' + await ctx.call('tools', 'call', 'commands_run', { name: 'cmd-owner/greet', args: { name: 'Bo' } }).then((v) => JSON.stringify(v), (e) => 'error: ' + e.message));
  ctx.on('commands:changed', async () => ctx.log('after ' + JSON.stringify((await ctx.call('commands', 'list')).filter((c) => c.plugin === 'cmd-owner').length)));
  ctx.log('runner-done');
};`);
    await pluginLog("cmd-runner", "runner-done");
    const list = await pluginLog("cmd-runner", "list");
    check("commands.list has each command a running plugin added and listens for, as <plugin>/<id>", list === 'list ["cmd-owner/fail","cmd-owner/greet","cmd-owner/plain","cmd-owner/shape","cmd-owner/twice"]', list);
    check("a command's keys are kept as written", (await pluginLog("cmd-runner", "keys")) === 'keys ["Mod+G"]');
    const refused = await a.evaluate(() => window.__host.traces.filter((e) => e.plugin === "cmd-owner" && /Couldn't add the command/.test(e.detail ?? "")).map((e) => e.detail));
    check("commands.add refuses a bad id and a shortcut it can't read", refused.length === 2 && refused.some((r) => /lowercase/.test(r)) && refused.some((r) => /isn't a shortcut/.test(r)), refused.join("; "));
    check("commands.run runs the owner's handler with the arguments, says who ran it, and returns its answer", (await pluginLog("cmd-runner", "greet ")) === 'greet "hello Ada from cmd-runner"', await pluginLog("cmd-runner", "greet "));
    check("commands.run checks the arguments against the command's schema", /error: .*name/.test(await pluginLog("cmd-runner", "greet-missing")), await pluginLog("cmd-runner", "greet-missing"));
    check("a handler that throws fails the run with its error", (await pluginLog("cmd-runner", "fail error")) === "fail error: boom", await pluginLog("cmd-runner", "fail "));
    check("a handler's answer comes back as it is, even an object with block or failed in it", (await pluginLog("cmd-runner", "shape")) === 'shape {"block":"paragraph","failed":false}', await pluginLog("cmd-runner", "shape"));
    check("adding a command's id again replaces its handler, and the old off() leaves the new one", (await pluginLog("cmd-runner", "twice")) === 'twice "new"', await pluginLog("cmd-runner", "twice"));
    check("a plugin listening to commands:before can stop a run", /error: cmd-owner\/plain was stopped: not for runners/.test(await pluginLog("cmd-runner", "plain")), await pluginLog("cmd-runner", "plain"));
    check("listening for a command name only answers the plugin's own command, never another's", /error: No command named cmd-copycat\/greet/.test(await pluginLog("cmd-runner", "copycat")) && !list.includes("cmd-copycat"));
    check("commands:ran tells plugins with `commands` what ran, and whether it worked", (await pluginLog("cmd-runner", "ran cmd-owner/fail")) === "ran cmd-owner/fail false" && (await pluginLog("cmd-runner", "ran cmd-owner/greet")) === "ran cmd-owner/greet true");
    check("listing and running commands need the commands permission", /Missing capability commands/.test(await pluginLog("cmd-blind", "blind")));
    const tools = await pluginLog("cmd-runner", "tools");
    check("an agent's tools include commands_list and commands_run", tools === 'tools ["commands_list","commands_run"]', tools);
    check("a model's tool call runs a command", (await pluginLog("cmd-runner", "tool")) === 'tool "hello Bo from cmd-runner"', await pluginLog("cmd-runner", "tool"));
    await a.evaluate(() => window.__host.command("uninstall", "cmd-owner"));
    check("a plugin's commands go when it stops, and commands:changed says so", (await pluginLog("cmd-runner", "after 0").catch(() => "")) === "after 0");

    // The palette in the reading list: Ctrl K (Cmd K on a Mac) opens it, typing finds a command, Enter runs it, and its keys run it from anywhere.
    const page = await openTab(`${URL}demos/reading-list/app.html`);
    const palette = 'ui-commands [data-command="library/start-next"]';
    const listed = await page.waitForSelector(palette, { state: "attached", timeout: 8000 }).then(() => true, () => false);
    check("the command palette lists the commands an app's plugins add, leaving out those that need arguments", listed && !(await page.$('ui-commands [data-command="library/add"]')));
    // The element loads the first time a view uses it; its shortcuts work once it is defined and has drawn its button.
    await page.waitForFunction(() => customElements.get("ui-commands") && document.querySelector("ui-commands")?.shadowRoot?.querySelector(".open"), null, { timeout: 8000 }).catch(() => {});
    const mod = await page.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"));
    await page.keyboard.press(`${mod}+k`);
    const opened = await page.waitForFunction(() => document.querySelector("ui-commands")?.shadowRoot?.querySelector("dialog")?.open, null, { timeout: 3000 }).then(() => true, () => false);
    check("Mod+K opens the palette with a search box", opened);
    await page.keyboard.type("next book");
    const options = await page.evaluate(() => [...document.querySelector("ui-commands").shadowRoot.querySelectorAll("[role=option]")].map((o) => o.textContent));
    check("typing narrows the palette to the commands that match", options.length === 1 && /Start the next book/.test(options[0]), options.join(" | "));
    await page.keyboard.press("Enter");
    const toast = () => page.waitForFunction(() => document.querySelector("ui-commands")?.shadowRoot?.querySelector(".toast:popover-open")?.textContent, null, { timeout: 5000 }).then((h) => h.jsonValue(), () => "");
    const started = await toast();
    check("Enter runs the picked command and shows what it said", /^Started /.test(started) || started === "Nothing left to read", started);
    await page.keyboard.press("Alt+d");
    const finished = await page.waitForFunction(() => /^(Finished|You aren't)/.test(document.querySelector("ui-commands")?.shadowRoot?.querySelector(".toast")?.textContent ?? ""), null, { timeout: 5000 }).then(() => true, () => false);
    check("a command's own shortcut runs it from anywhere on the page", finished);
    await page.close();
  } finally {
    for (const id of ids) await a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
  }
}
