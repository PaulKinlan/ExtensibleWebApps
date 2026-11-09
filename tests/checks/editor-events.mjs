// Editor view events (src/host/editing.ts): a textarea or <ui-editor> sends its
// selection, pastes and drops to its plugin, which runs them through hooks of
// its own; here the notes plugin's notes:selection and notes:paste. And the
// folder service (std/folder/module.ts): reading needs folder:read, writing
// folder:write, and a path can't leave the folder or reach .git or .env.

export default async function ({ a, check, openTab, WORKBENCH }) {
  const install = (src) => a.evaluate((source) => window.__host.command("install", source), src);
  const uninstall = (id) => a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
  const ids = ["shouty-paste", "folder-reader", "folder-writer"];
  const page = await openTab(WORKBENCH);
  const logged = (id, prefix) => page.waitForFunction(([i, p]) => window.__host.traces.find((e) => e.plugin === i && e.detail?.startsWith(p))?.detail, [id, prefix], { timeout: 6000 }).then((h) => h.jsonValue(), () => "");
  try {
    // A plugin that hears the selection and makes every paste shout.
    await install(`export const manifest = { id: 'shouty-paste', name: 'Shouty paste', permissions: ['hook:listen:notes:selection', 'hook:intercept:notes:paste'] };
export default (ctx) => {
  ctx.on('notes:selection', (s) => ctx.log('selected ' + JSON.stringify(s.text)));
  ctx.on('notes:paste', (p) => ({ text: p.text.toUpperCase() }));
};`);
    await page.click('[data-key="notes:list"] button >> text=New note');
    const box = '[data-key="notes:editor"] textarea[name="text"]';
    await page.waitForSelector(box, { timeout: 8000 });
    await page.fill(box, "hello world");
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      el.focus();
      el.setSelectionRange(6, 11);
      el.dispatchEvent(new Event("select", { bubbles: true }));
      document.dispatchEvent(new Event("selectionchange"));
    }, box);
    check("a textarea's selection reaches the plugin's selection hook", (await logged("shouty-paste", "selected ")) === 'selected "world"', await logged("shouty-paste", "selected "));

    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const data = new DataTransfer();
      data.setData("text/plain", "there");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, box);
    const pasted = await page.waitForFunction((sel) => document.querySelector(sel)?.value === "hello THERE", box, { timeout: 6000 }).then(() => true, () => false);
    check("a paste runs through the plugin's paste hook, which can change what goes in", pasted, await page.inputValue(box));

    // The folder service.
    await install(`export const manifest = { id: 'folder-reader', name: 'Folder reader', permissions: ['folder:read'], services: ['folder'] };
export default async (ctx) => {
  const tryIt = (p) => p.then((v) => 'ok ' + JSON.stringify(v), (e) => 'no ' + e.message);
  ctx.log('reader-write ' + await tryIt(ctx.call('folder', 'write', 'notes.md', 'x')));
  ctx.log('reader-up ' + await tryIt(ctx.call('folder', 'read', '../secret')));
  ctx.log('reader-about ' + await tryIt(ctx.call('folder', 'about')));
};`);
    check("writing to the folder needs folder:write", /^reader-write no .*folder:write/.test(await logged("folder-reader", "reader-write")), await logged("folder-reader", "reader-write"));
    check("a path can't climb out of the folder", /^reader-up no /.test(await logged("folder-reader", "reader-up")), await logged("folder-reader", "reader-up"));

    await install(`export const manifest = { id: 'folder-writer', name: 'Folder writer', permissions: ['folder:read', 'folder:write'], services: ['folder'] };
export default async (ctx) => {
  const tryIt = (p) => p.then((v) => 'ok ' + JSON.stringify(v), (e) => 'no ' + e.message);
  ctx.log('writer-git ' + await tryIt(ctx.call('folder', 'write', '.git/config', 'x')));
  ctx.log('writer-env ' + await tryIt(ctx.call('folder', 'write', '.env', 'x')));
  await ctx.call('folder', 'write', 'checks/editor-events.md', 'kept');
  ctx.log('writer-back ' + await tryIt(ctx.call('folder', 'read', 'checks/editor-events.md')));
  ctx.log('writer-list ' + await tryIt(ctx.call('folder', 'list', 'checks')));
};`);
    check("a plugin can't write to .git or .env in the folder", /^writer-git no /.test(await logged("folder-writer", "writer-git")) && /^writer-env no /.test(await logged("folder-writer", "writer-env")), `${await logged("folder-writer", "writer-git")}; ${await logged("folder-writer", "writer-env")}`);
    check("a written file reads back and is listed", (await logged("folder-writer", "writer-back")) === 'writer-back ok "kept"' && /checks\/editor-events\.md/.test(await logged("folder-writer", "writer-list")), await logged("folder-writer", "writer-list"));
  } finally {
    for (const id of ids) await uninstall(id);
    await page.close();
  }
}
