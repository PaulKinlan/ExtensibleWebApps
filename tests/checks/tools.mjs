// The tools service (src/kernel/services/tools.ts): the service methods a
// plugin may call, described as tools for a language model, and calling one
// through the same gate as ctx.call. The first piece of the agent plugin.

export default async function ({ a, check }) {
  const plugin = (src) => a.evaluate((source) => window.__host.command("install", source), src);
  const pluginLog = (id, prefix) => a.waitForFunction(([i, p]) => window.__host.traces.findLast((e) => e.plugin === i && e.detail?.startsWith(p)), [id, prefix], { timeout: 5000 }).then((h) => h.jsonValue()).then((e) => e.detail);
  const tryCall = `const tryCall = (name, args) => ctx.call('tools', 'call', name, args).then((v) => JSON.stringify(v), (e) => 'error: ' + e.message);`;
  try {
    await plugin(`export const manifest = { id: 'toolbox', name: 'Toolbox', permissions: ['files:exports'], collections: { gadgets: { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } } };
export default async (ctx) => {
  ${tryCall}
  const tools = await ctx.call('tools', 'list');
  ctx.log('toolbox-names ' + tools.map((t) => t.name).sort().join(','));
  const put = tools.find((t) => t.name === 'data_put');
  ctx.log('toolbox-put ' + JSON.stringify({ enum: put.parameters.properties.collection.enum, required: put.parameters.required, reviewed: put.reviewed, extra: put.parameters.additionalProperties }));
  ctx.log('toolbox-shape ' + tools.every((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name) && t.description && t.parameters.type === 'object'));
  ctx.log('toolbox-write ' + await tryCall('data_put', { collection: 'gadgets', record: { title: 'kettle' } }));
  ctx.log('toolbox-read ' + await tryCall('data_list', { collection: 'gadgets' }).then((t) => JSON.parse(t).map((r) => r.title).join(',')));
  ctx.log('toolbox-invalid ' + await tryCall('data_put', { collection: 'gadgets', record: {} }));
  ctx.log('toolbox-other ' + await tryCall('data_list', { collection: 'notes' }));
  ctx.log('toolbox-extra ' + await tryCall('data_list', { collection: 'gadgets', limit: 3 }));
  ctx.log('toolbox-missing ' + await tryCall('data_get', { collection: 'gadgets' }));
  ctx.log('toolbox-gate ' + await tryCall('files_read', { path: 'secret-folder/x.txt' }));
  ctx.log('toolbox-none ' + await tryCall('audio_play', {}));
};`);
    const names = await pluginLog("toolbox", "toolbox-names").catch(() => "");
    const list = names.replace("toolbox-names ", "").split(",");
    check("tools.list offers the methods a plugin may call, named service_method", ["data_collections", "data_delete", "data_get", "data_list", "data_put", "files_read", "files_write", "kernel_hooks", "settings_get", "storage_get", "storage_set"].every((n) => list.includes(n)), names);
    check("tools.list leaves out what the manifest doesn't grant, the model itself, and tools", !["store_list", "net_fetch", "audio_play", "llm_complete", "tools_list"].some((n) => list.includes(n)), names);
    check(
      "a tool that names a collection offers only those the plugin may use, and says it may be reviewed",
      (await pluginLog("toolbox", "toolbox-put").catch(() => "")) === 'toolbox-put {"enum":["gadgets"],"required":["collection","record"],"reviewed":true,"extra":false}',
    );
    check("each tool has a name, a description and an object schema that llm.complete accepts", (await pluginLog("toolbox", "toolbox-shape").catch(() => "")) === "toolbox-shape true");
    check("tools.call calls the method with the model's arguments in order", /^toolbox-write \{"ok":true,"id":/.test(await pluginLog("toolbox", "toolbox-write").catch(() => "")));
    check("a tool's answer is the method's answer", (await pluginLog("toolbox", "toolbox-read").catch(() => "")) === "toolbox-read kettle");
    check("the method's own checks still apply to a tool call", /^toolbox-invalid \{"ok":false,.*"errors":\[/.test(await pluginLog("toolbox", "toolbox-invalid").catch(() => "")));
    check("tools.call refuses a name outside the tool's list, an unknown argument and a missing one", /must be one of gadgets/.test(await pluginLog("toolbox", "toolbox-other").catch(() => "")) && /has no argument limit/.test(await pluginLog("toolbox", "toolbox-extra").catch(() => "")) && /id is required/.test(await pluginLog("toolbox", "toolbox-missing").catch(() => "")));
    check("a tool call goes through the gate, like ctx.call", /Missing capability files:secret-folder/.test(await pluginLog("toolbox", "toolbox-gate").catch(() => "")));
    check("tools.call refuses a tool the plugin wasn't offered", /No tool named audio_play/.test(await pluginLog("toolbox", "toolbox-none").catch(() => "")));

    await plugin(`export const manifest = { id: 'bare-tools', name: 'Bare tools', permissions: [] };
export default async (ctx) => {
  ${tryCall}
  ctx.log('bare-names ' + (await ctx.call('tools', 'list')).map((t) => t.name).sort().join(','));
  ctx.log('bare-files ' + await tryCall('files_read', { path: 'exports/x.txt' }));
};`);
    check("a plugin that may do nothing is offered only what needs nothing", (await pluginLog("bare-tools", "bare-names").catch(() => "")) === "bare-names data_collections,kernel_hooks,settings_get,storage_get,storage_set");
    check("a plugin can't call a tool it wasn't offered", /No tool named files_read/.test(await pluginLog("bare-tools", "bare-files").catch(() => "")));
  } finally {
    for (const id of ["toolbox", "bare-tools"]) await a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
  }
}
