// The tools service (std/tools/module.ts): the service methods a
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
  const put = tools.find((t) => t.name === 'data_put_gadgets');
  const record = put.parameters.properties.record;
  ctx.log('toolbox-put ' + JSON.stringify({ args: Object.keys(put.parameters.properties), required: put.parameters.required, fields: Object.keys(record.properties), recordRequired: record.required, reviewed: put.reviewed, extra: put.parameters.additionalProperties }));
  ctx.log('toolbox-shape ' + tools.every((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name) && t.description && t.parameters.type === 'object'));
  ctx.log('toolbox-write ' + await tryCall('data_put_gadgets', { record: { title: 'kettle' } }));
  ctx.log('toolbox-read ' + await tryCall('data_list_gadgets', {}).then((t) => JSON.parse(t).map((r) => r.title).join(',')));
  ctx.log('toolbox-invalid ' + await tryCall('data_put_gadgets', { record: {} }));
  ctx.log('toolbox-extra ' + await tryCall('data_list_gadgets', { limit: 3 }));
  ctx.log('toolbox-missing ' + await tryCall('data_get_gadgets', {}));
  ctx.log('toolbox-gate ' + await tryCall('files_read', { path: 'secret-folder/x.txt' }));
  ctx.log('toolbox-none ' + await tryCall('audio_play', {}));
};`);
    const names = await pluginLog("toolbox", "toolbox-names").catch(() => "");
    const list = names.replace("toolbox-names ", "").split(",");
    check("tools.list offers the methods a plugin may call, named service_method", ["data_collections", "data_delete_gadgets", "data_get_gadgets", "data_list_gadgets", "data_put_gadgets", "files_read", "files_write", "kernel_hooks", "settings_get", "storage_get", "storage_set"].every((n) => list.includes(n)), names);
    check("tools.list leaves out what the manifest doesn't grant, the model itself, and tools", !["data_put", "data_list", "store_list", "net_fetch", "audio_play", "llm_complete", "tools_list"].some((n) => list.includes(n)), names);
    check(
      "a method that takes a collection becomes one tool for each of a plugin's few collections, with that collection's fields",
      (await pluginLog("toolbox", "toolbox-put").catch(() => "")) === 'toolbox-put {"args":["record","reason"],"required":["record"],"fields":["id","title"],"recordRequired":["title"],"reviewed":true,"extra":false}',
    );
    check("each tool has a name, a description and an object schema that llm.complete accepts", (await pluginLog("toolbox", "toolbox-shape").catch(() => "")) === "toolbox-shape true");
    check("tools.call calls the method with the model's arguments in order", /^toolbox-write \{"ok":true,"id":/.test(await pluginLog("toolbox", "toolbox-write").catch(() => "")));
    check("a tool's answer is the method's answer", (await pluginLog("toolbox", "toolbox-read").catch(() => "")) === "toolbox-read kettle");
    check("a record is checked against its collection's schema before the call", /toolbox-invalid error: .*title is required/.test(await pluginLog("toolbox", "toolbox-invalid").catch(() => "")));
    check("tools.call refuses an unknown argument and a missing one", /has no argument limit/.test(await pluginLog("toolbox", "toolbox-extra").catch(() => "")) && /id is required/.test(await pluginLog("toolbox", "toolbox-missing").catch(() => "")));
    check("a tool call goes through the gate, like ctx.call", /Missing capability files:secret-folder/.test(await pluginLog("toolbox", "toolbox-gate").catch(() => "")));
    check("tools.call refuses a tool the plugin wasn't offered", /No tool named audio_play/.test(await pluginLog("toolbox", "toolbox-none").catch(() => "")));

    // Past a few collections, one tool takes the collection's name, from those the plugin may use.
    await plugin(`export const manifest = { id: 'shelves', name: 'Shelves', permissions: ['data:read:c1', 'data:read:c2', 'data:read:c3', 'data:read:c4', 'data:read:c5', 'data:read:c6'] };
export default async (ctx) => {
  ${tryCall}
  const tools = await ctx.call('tools', 'list');
  ctx.log('shelves-list ' + JSON.stringify(tools.find((t) => t.name === 'data_list')?.parameters.properties.collection.enum));
  ctx.log('shelves-other ' + await tryCall('data_list', { collection: 'gadgets' }));
  ctx.log('shelves-read ' + await tryCall('data_list', { collection: 'c3' }));
};`);
    check("past a few collections, one tool offers the collections the plugin may read", (await pluginLog("shelves", "shelves-list").catch(() => "")) === 'shelves-list ["c1","c2","c3","c4","c5","c6"]');
    check("tools.call refuses a collection outside the tool's list", /must be one of c1/.test(await pluginLog("shelves", "shelves-other").catch(() => "")) && (await pluginLog("shelves", "shelves-read").catch(() => "")) === "shelves-read []");

    await plugin(`export const manifest = { id: 'bare-tools', name: 'Bare tools', permissions: [] };
export default async (ctx) => {
  ${tryCall}
  ctx.log('bare-names ' + (await ctx.call('tools', 'list')).map((t) => t.name).sort().join(','));
  ctx.log('bare-files ' + await tryCall('files_read', { path: 'exports/x.txt' }));
  await tryCall('storage_set', { key: 'k', value: 1 });
  ctx.log('bare-null ' + await tryCall('storage_set', { key: 'k', value: null }) + ' ' + await tryCall('storage_get', { key: 'k' }));
  ctx.log('bare-empty ' + await tryCall('storage_set', { key: '', value: '' }) + ' ' + await tryCall('storage_get', { key: '' }));
};`);
    check("a plugin that may do nothing is offered only what needs nothing", (await pluginLog("bare-tools", "bare-names").catch(() => "")) === "bare-names data_collections,kernel_hooks,settings_get,storage_get,storage_set");
    check("a plugin can't call a tool it wasn't offered", /No tool named files_read/.test(await pluginLog("bare-tools", "bare-files").catch(() => "")));
    check("a required argument may be null, when the method takes null", (await pluginLog("bare-tools", "bare-null").catch(() => "")) === "bare-null true null");
    check("a required argument may be an empty string", (await pluginLog("bare-tools", "bare-empty").catch(() => "")) === 'bare-empty true ""');

    // A narrower wildcard offers the collections it matches, not every collection.
    await plugin(`export const manifest = { id: 'wild-tools', name: 'Wild tools', permissions: ['data:read:gad*'] };
export default async (ctx) => { ctx.log('wild-names ' + (await ctx.call('tools', 'list')).map((t) => t.name).filter((n) => n.startsWith('data_')).sort().join(',')); };`);
    check("a narrower wildcard offers only the collections it matches", (await pluginLog("wild-tools", "wild-names").catch(() => "")) === "wild-names data_collections,data_get_gadgets,data_list_gadgets");
  } finally {
    for (const id of ["toolbox", "shelves", "bare-tools", "wild-tools"]) await a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
  }
}
