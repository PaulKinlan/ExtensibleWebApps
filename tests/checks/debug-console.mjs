// The debug console (std/debug-console.js), in the spending demo: its bug counts
// problems, opens a log, and copies it; and only plugins with debug:read see the trace.
export default async function ({ a, check, context, URL, openTab, errors, plugin, pluginLog, traceHas }) {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: URL });
  const debugPage = await openTab(`${URL}demos/spending/app.html`);
  await debugPage.waitForSelector("ui-debug .bug", { timeout: 8000 });
  // An uncaught error in the page is reported to the kernel, and reaches the console through the trace.
  await debugPage.evaluate(() => setTimeout(() => { throw new Error("debug-test boom"); }));
  const counted = await debugPage.waitForFunction(() => Number(document.querySelector("ui-debug")?.getAttribute("problems")) > 0, null, { timeout: 5000 }).then(() => true, () => false);
  check("the debug console counts an uncaught page error on its bug", counted, await debugPage.evaluate(() => document.querySelector("ui-debug")?.getAttribute("problems")));
  await debugPage.click("ui-debug .bug");
  const logged = await debugPage.waitForSelector('ui-debug pre[data-copy-source="log"] >> text=debug-test boom', { timeout: 5000 }).then(() => true, () => false);
  await debugPage.click('ui-debug button[data-value="all"]');
  const everything = await debugPage.waitForSelector('ui-debug pre[data-copy-source="log"] >> text=plugin:ready', { timeout: 5000 }).then(() => true, () => false);
  check("opening it shows the problems, and Everything shows the whole trace", logged && everything);
  await debugPage.click("ui-debug button[data-copy]");
  await debugPage.waitForFunction(() => /Copied/.test(document.querySelector("ui-debug")?.shadowRoot?.getElementById("status")?.textContent ?? ""), null, { timeout: 3000 }).catch(() => {});
  const clipboard = await debugPage.evaluate(() => navigator.clipboard.readText()).catch((e) => String(e));
  check("Copy puts the log on the clipboard, headed with the page's address", clipboard.includes("/demos/spending/app.html") && clipboard.includes("debug-test boom") && clipboard.includes("plugin:ready"), clipboard.slice(0, 200));
  const lines = clipboard.split("\n").filter((l) => /^\d\d:\d\d:\d\d\.\d{3}  /.test(l));
  check("each trace event is in the log once, though the snapshot and the first batches overlap", lines.length > 5 && new Set(lines).size === lines.length, `${lines.length} lines, ${new Set(lines).size} different`);
  // A second tab on the same app: its console starts before the tab has said which plugins its app links.
  const debugPage2 = await openTab(`${URL}demos/spending/app.html`);
  await debugPage2.waitForSelector("ui-debug .bug", { state: "attached", timeout: 8000 });
  await debugPage2.click("ui-debug .bug");
  const knowsApp = await debugPage2.waitForSelector('ui-debug input[data-action="only-this-app"]', { timeout: 5000 }).then(() => true, () => false);
  check("a console that starts before its tab opens the app learns the app's plugins once it does", knowsApp);
  await debugPage2.close({ runBeforeUnload: true });
  await debugPage.keyboard.press("Escape");
  check("Escape closes the panel", await debugPage.evaluate(() => !document.querySelector("ui-debug")?.shadowRoot?.getElementById("panel")?.matches(":popover-open")));
  await debugPage.close({ runBeforeUnload: true });
  // That error was thrown on purpose.
  for (let i = errors.length - 1; i >= 0; i--) if (errors[i].includes("debug-test boom")) errors.splice(i, 1);
  // Without debug:read a plugin can neither read the trace nor hear it.
  await plugin(`export const manifest = { id: 'peeker', name: 'Peeker', permissions: [] };
export default async (ctx) => {
  ctx.on('debug:trace', () => ctx.log('peeker heard'));
  try { await ctx.call('debug', 'recent'); ctx.log('peeker read'); } catch (e) { ctx.log('peeker refused: ' + e.message); }
};`);
  const peeked = await pluginLog("peeker", "peeker");
  await a.waitForFunction(() => window.__host.traces.some((e) => e.kind === "denied" && e.plugin === "peeker" && e.name === "debug:read"), null, { timeout: 3000 }).catch(() => {});
  const peekDenied = await traceHas(a, `(e) => e.kind === "denied" && e.plugin === "peeker" && e.name === "debug:read"`);
  check("without debug:read a plugin can neither read the trace nor hear it", peeked === "peeker refused: Missing capability debug:read" && peekDenied, peeked);
  await a.evaluate(() => window.__host.command("uninstall", "peeker"));
}
