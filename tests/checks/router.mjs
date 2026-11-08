// The router service (src/kernel/services/router.ts): the screen a tab shows,
// from its address's hash. The reading-list demo's checks cover links, back
// and opening a book's address in a new tab; these cover the service itself.

export default async function ({ a, check, plugin, pluginLog }) {
  const ids = ["router-mover", "router-blind"];
  try {
    await a.evaluate(() => (location.hash = ""));
    await plugin(`export const manifest = { id: 'router-mover', name: 'Mover', permissions: ['router'] };
export default async (ctx) => {
  ctx.on('router:changed', async (change) => ctx.log('mover-heard ' + JSON.stringify({ path: change.path, query: change.query, tab: !!change.tab })));
  ctx.log('mover-start ' + JSON.stringify((await ctx.call('router', 'current')).path));
  await ctx.call('router', 'go', '/shelf/3?view=grid');
  ctx.log('mover-bad ' + await ctx.call('router', 'go', 'shelf').then(() => 'moved', (e) => e.message));
};`);
    await plugin(`export const manifest = { id: 'router-blind', name: 'Blind', permissions: [] };
export default async (ctx) => { ctx.log('blind ' + await ctx.call('router', 'current').then(() => 'answered', (e) => e.message)); };`);
    check("router.current says / when the address has no screen", (await pluginLog("router-mover", "mover-start")) === 'mover-start "/"', await pluginLog("router-mover", "mover-start"));
    const heard = await pluginLog("router-mover", "mover-heard").catch(() => "");
    check("router.go moves the tab, and router:changed tells plugins the path and query", heard === 'mover-heard {"path":"/shelf/3","query":{"view":"grid"},"tab":true}' && (await a.evaluate(() => location.hash)) === "#/shelf/3?view=grid", heard);
    check("router.go takes only a path that starts with /", /starts with \//.test(await pluginLog("router-mover", "mover-bad")));
    check("the router needs the router permission", /Missing capability router/.test(await pluginLog("router-blind", "blind")));
  } finally {
    for (const id of ids) await a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
    await a.evaluate(() => history.replaceState(null, "", location.pathname + location.search));
  }
}
