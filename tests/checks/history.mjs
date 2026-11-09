// The history service (std/history/module.ts): undo and redo across
// every write to an app's collections. The spending demo's checks cover the
// Undo and Redo buttons (std/undo.js); these cover the service itself.

export default async function ({ check, plugin, pluginLog, a }) {
  const ids = ["hist-owner", "hist-undoer", "hist-blind"];
  try {
    await plugin(`export const manifest = { id: 'hist-owner', name: 'Owner', permissions: [], collections: { 'hist-jobs': { title: 'Jobs', schema: { type: 'object', properties: { title: { type: 'string' } } } } } };
export default async (ctx) => {
  const { id } = await ctx.call('data', 'put', 'hist-jobs', { title: 'Paint the fence' });
  await ctx.call('data', 'put', 'hist-jobs', { id, title: 'Paint the shed' });
  ctx.log('owner-done ' + id);
};`);
    const id = (await pluginLog("hist-owner", "owner-done")).split(" ")[1];
    await plugin(`export const manifest = { id: 'hist-undoer', name: 'Undoer', permissions: ['history', 'data:read:hist-jobs'] };
export default async (ctx) => {
  const title = async () => (await ctx.call('data', 'get', 'hist-jobs', '${id}'))?.title ?? 'gone';
  ctx.log('undoer-state ' + JSON.stringify((await ctx.call('history', 'state')).undo));
  await ctx.call('history', 'undo');
  ctx.log('undoer-1 ' + await title());
  await ctx.call('history', 'undo');
  ctx.log('undoer-2 ' + await title());
  await ctx.call('history', 'redo');
  ctx.log('undoer-3 ' + await title());
  ctx.log('undoer-redo ' + JSON.stringify((await ctx.call('history', 'state')).redo?.text));
};`);
    await plugin(`export const manifest = { id: 'hist-blind', name: 'Blind', permissions: [] };
export default async (ctx) => { ctx.log('blind ' + await ctx.call('history', 'undo').then(() => 'undid', (e) => e.message)); };`);
    const state = await pluginLog("hist-undoer", "undoer-state");
    check("history.state says what Undo would do, in words", /"kind":"edit".*"text":"edit “Paint the shed” in Jobs"/.test(state) && /"by":"hist-owner"/.test(state), state);
    check("undo takes back the latest write, then the one before", (await pluginLog("hist-undoer", "undoer-1")) === "undoer-1 Paint the fence" && (await pluginLog("hist-undoer", "undoer-2")) === "undoer-2 gone");
    check("redo makes an undone write again", (await pluginLog("hist-undoer", "undoer-3")) === "undoer-3 Paint the fence" && (await pluginLog("hist-undoer", "undoer-redo")) === 'undoer-redo "edit “Paint the shed” in Jobs"', await pluginLog("hist-undoer", "undoer-redo"));
    check("history needs the history permission", /Missing capability history/.test(await pluginLog("hist-blind", "blind")));
    check("each undo is in the trace", await a.evaluate(() => window.__host.traces.some((e) => e.name === "history:undo" && e.detail === "edit “Paint the shed” in Jobs")));
  } finally {
    for (const id of ids) await a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
  }
}
