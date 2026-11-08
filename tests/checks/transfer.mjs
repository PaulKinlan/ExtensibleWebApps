// The transfer service (src/kernel/services/transfer.ts): import and export for
// the person. The spending demo's checks cover the buttons (std/import-export.js),
// a bank statement's import and a CSV export; these cover the service's limits.

export default async function ({ check, plugin, pluginLog, a }) {
  const ids = ["transfer-owner", "transfer-blind"];
  try {
    await plugin(`export const manifest = { id: 'transfer-owner', name: 'Owner', permissions: ['transfer'], collections: { 'transfer-jobs': { title: 'Jobs', schema: { type: 'object', properties: { title: { type: 'string' } } } } } };
export default async (ctx) => {
  await ctx.call('data', 'put', 'transfer-jobs', { title: 'Paint the fence' });
  const mine = (await ctx.call('transfer', 'collections')).find((c) => c.name === 'transfer-jobs');
  ctx.log('owner-list ' + JSON.stringify(mine));
  ctx.log('owner-import ' + await ctx.call('transfer', 'import', 'transfer-jobs').then((r) => JSON.stringify(r), (e) => e.message));
  ctx.log('owner-unknown ' + await ctx.call('transfer', 'export', 'no-such-thing').then(() => 'saved', (e) => e.message));
};`);
    await plugin(`export const manifest = { id: 'transfer-blind', name: 'Blind', permissions: [] };
export default async (ctx) => { ctx.log('blind ' + await ctx.call('transfer', 'collections').then(() => 'listed', (e) => e.message)); };`);
    const listed = await pluginLog("transfer-owner", "owner-list");
    check("transfer.collections lists a collection with its count and fields", /"name":"transfer-jobs","title":"Jobs","count":1,"fields":\["title"\]/.test(listed), listed);
    const imported = await pluginLog("transfer-owner", "owner-import");
    // Without a click just before, the chooser can't open and import says so; after one (an earlier check's), the chooser is closed unanswered.
    check("an import with no file chosen ends, without writing", /only right after the person clicks|"cancelled":true/.test(imported), imported);
    check("export names an unknown collection", /No collection named no-such-thing/.test(await pluginLog("transfer-owner", "owner-unknown")));
    check("transfer needs the transfer permission", /Missing capability transfer/.test(await pluginLog("transfer-blind", "blind")));
  } finally {
    for (const id of ids) await a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
  }
}
