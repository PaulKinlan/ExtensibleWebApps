// The router service (std/router/module.ts): the screen a tab shows,
// from its address. The reading-list demo's checks cover links, back
// and opening a book's address in a new tab; these cover the service itself.

export default async function ({ a, check, plugin, pluginLog }) {
  const ids = ["router-mover", "router-blind"];
  try {
        await plugin(`export const manifest = { id: 'router-mover', name: 'Mover', permissions: ['router'] };
export default async (ctx) => {
  ctx.on('router:changed', async (change) => ctx.log('mover-heard ' + JSON.stringify({ path: change.path, query: change.query, tab: !!change.tab })));
  ctx.log('mover-start ' + JSON.stringify((await ctx.call('router', 'current')).path));
  await ctx.call('router', 'go', '/shelf/3?view=grid');
  ctx.log('mover-bad ' + await ctx.call('router', 'go', 'shelf').then(() => 'moved', (e) => e.message));
  const many = Array.from({ length: 51 }, (_, i) => 'q' + i + '=1').join('&');
  ctx.log('mover-many ' + await ctx.call('router', 'go', '/shelf?' + many).then(() => 'moved', (e) => e.message));
  await new Promise((r) => setTimeout(r, 300));
  await ctx.call('router', 'go', '/search?next=/book/42?tab=notes&mode=compact');
};`);
    await plugin(`export const manifest = { id: 'router-blind', name: 'Blind', permissions: [] };
export default async (ctx) => { ctx.log('blind ' + await ctx.call('router', 'current').then(() => 'answered', (e) => e.message)); };`);
    check("router.current says / when the address has no screen", (await pluginLog("router-mover", "mover-start")) === 'mover-start "/"', await pluginLog("router-mover", "mover-start"));
    const heard = await pluginLog("router-mover", 'mover-heard {"path":"/shelf/3"').catch(() => "");
    check("router.go moves the tab, and router:changed tells plugins the path and query", heard === 'mover-heard {"path":"/shelf/3","query":{"view":"grid"},"tab":true}' && (await a.evaluate(() => location.pathname + location.search)) === "/workbench/shelf/3?view=grid", heard);
    check("router.go takes only a path that starts with /", /starts with \//.test(await pluginLog("router-mover", "mover-bad")));
    check("router.go refuses an address the kernel wouldn't keep, so the page and the kernel agree", /at most 50 query values/.test(await pluginLog("router-mover", "mover-many")), await pluginLog("router-mover", "mover-many"));
    const second = await a.waitForFunction(() => window.__host.traces.some((e) => e.plugin === "router-mover" && e.detail?.includes("/search")), null, { timeout: 5000 }).then(() => a.evaluate(() => window.__host.traces.find((e) => e.plugin === "router-mover" && e.detail?.includes("/search")).detail), () => "");
    check("only the first ? starts the query: a value may hold another", second.includes('"query":{"next":"/book/42?tab=notes","mode":"compact"}'), second);
    check("the router needs the router permission", /Missing capability router/.test(await pluginLog("router-blind", "blind")));
  } finally {
    for (const id of ids) await a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
    await a.evaluate(() => history.replaceState(null, "", "/workbench/"));
  }
}
