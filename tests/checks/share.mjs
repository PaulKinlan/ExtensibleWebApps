// The share service (std/share/module.ts). The reading list's checks cover
// sending a book's address and receiving a shared page; these cover its limits.

export default async function ({ check, plugin, pluginLog, a }) {
  const ids = ["share-sharer", "share-blind"];
  try {
    await plugin(`export const manifest = { id: 'share-sharer', name: 'Sharer', permissions: ['share'] };
export default async (ctx) => {
  ctx.log('sharer-take ' + JSON.stringify(await ctx.call('share', 'take')));
  ctx.log('sharer-empty ' + await ctx.call('share', 'send', { title: '' }).then(() => 'sent', (e) => e.message));
};`);
    await plugin(`export const manifest = { id: 'share-blind', name: 'Blind', permissions: [] };
export default async (ctx) => { ctx.log('blind ' + await ctx.call('share', 'take').then(() => 'took', (e) => e.message)); };`);
    check("share.take is null when nothing was shared", (await pluginLog("share-sharer", "sharer-take")) === "sharer-take null");
    check("share.send needs a title, text or link", /takes \{ title\?, text\?, url\? \}/.test(await pluginLog("share-sharer", "sharer-empty")));
    check("share needs the share permission", /Missing capability share/.test(await pluginLog("share-blind", "blind")));
  } finally {
    for (const id of ids) await a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
  }
}
