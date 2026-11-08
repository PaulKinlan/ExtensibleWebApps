// Hooks a plugin defines in its manifest (docs/guide/plugin-hooks.md): named
// `<plugin>:<key>`, run only by that plugin with ctx.hooks, listened to through
// the gate like the kernel's, even before the plugin that defines them is
// installed, and gone with it.

export default async function ({ a, check }) {
  const install = (src) => a.evaluate((source) => window.__host.command("install", source), src);
  const uninstall = (id) => a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
  const logs = (id, prefix) => a.evaluate(([i, p]) => window.__host.traces.filter((e) => e.plugin === i && e.detail?.startsWith(p)).map((e) => e.detail), [id, prefix]);
  const waitLog = (id, prefix, n = 1) => a.waitForFunction(([i, p, k]) => window.__host.traces.filter((e) => e.plugin === i && e.detail?.startsWith(p)).length >= k, [id, prefix, n], { timeout: 5000 }).then(() => true, () => false);

  const jukebox = `export const manifest = { id: 'jukebox', name: 'Jukebox', permissions: [], hooks: {
  played: { mode: 'emit', args: '{ song }', description: 'A song was played.' },
  'before-play': { mode: 'serial', timeoutMs: 2000, description: 'Before a song plays. Return { block } to stop it.' },
} };
export default async (ctx) => {
  await new Promise((r) => setTimeout(r, 300));
  await ctx.hooks.emit('played', { song: 'first' });
  ctx.log('jukebox-loud ' + JSON.stringify(await ctx.hooks.call('before-play', { loud: true })));
  ctx.log('jukebox-quiet ' + JSON.stringify(await ctx.hooks.call('before-play', { loud: false })));
  ctx.log('jukebox-wrong ' + await ctx.hooks.call('played', {}).then(() => 'ran', (e) => e.message));
  ctx.log('jukebox-none ' + await ctx.hooks.emit('nope', {}).then(() => 'ran', (e) => e.message));
};`;

  try {
    // The listener comes first: jukebox isn't installed, so its hooks don't exist yet.
    await install(`export const manifest = { id: 'hook-listener', name: 'Hook listener', permissions: ['hook:listen:jukebox:played', 'hook:intercept:jukebox:before-play'] };
export default (ctx) => {
  ctx.on('jukebox:played', (value) => ctx.log('listener-heard ' + value.song));
  ctx.on('jukebox:before-play', (value) => (value.loud ? { block: 'too loud' } : undefined));
  ctx.on('jukebox:secret', () => {});
  ctx.hooks.emit('played', { song: 'forged' }).catch((e) => ctx.log('listener-forge ' + e.message));
};`);
    await a.waitForFunction(() => window.__host.traces.some((e) => e.name === "hook:ahead" && e.plugin === "hook-listener"), null, { timeout: 5000 }).catch(() => {});
    const denied = await a.waitForFunction(() => window.__host.traces.some((e) => e.kind === "denied" && e.plugin === "hook-listener" && e.name === "hook:listen:jukebox:secret"), null, { timeout: 5000 }).then(() => true, () => false);
    check("listening to a plugin's hook needs the capability, even before the plugin is installed", denied);
    check("a plugin can't run a hook another plugin defines", await waitLog("hook-listener", "listener-forge hook-listener has no hook played"), (await logs("hook-listener", "listener-forge")).join("; "));

    const installed = await install(jukebox);
    check("a plugin with hooks in its manifest installs", installed.ok, JSON.stringify(installed));
    const heard = await waitLog("hook-listener", "listener-heard first");
    check("a listener that came first hears the hook once its plugin is installed", heard, (await logs("hook-listener", "listener-heard")).join("; "));
    await waitLog("jukebox", "jukebox-none");
    const [loud] = await logs("jukebox", "jukebox-loud");
    const [quiet] = await logs("jukebox", "jukebox-quiet");
    check("ctx.hooks.call runs a serial hook and hears a listener's block", loud === 'jukebox-loud {"block":"too loud"}' && quiet === "jukebox-quiet null", `${loud}; ${quiet}`);
    const [wrong] = await logs("jukebox", "jukebox-wrong");
    const [none] = await logs("jukebox", "jukebox-none");
    check("a hook is run the way its mode says, and only if the manifest defines it", /run it with hooks\.emit/.test(wrong ?? "") && /has no hook nope/.test(none ?? ""), `${wrong}; ${none}`);

    const reference = await a.evaluate(() => window.__host.command("reference"));
    const hook = (await a.evaluate(() => window.__host.command("reference"))).data.plugins.find((p) => p.id === "jukebox");
    check("the reference lists a plugin's hooks under it, not as the kernel's", ["jukebox:played", "jukebox:before-play"].every((h) => hook?.defines.includes(h)) && !reference.data.hooks.some((h) => h.name.startsWith("jukebox:")), hook?.defines.join(" "));
    const spec = await a.evaluate(() => window.__host.command("install", "export const manifest = { id: 'jukebox-probe', name: 'Probe', permissions: [] };\nexport default async (ctx) => ctx.log('probe ' + JSON.stringify((await ctx.call('kernel', 'hooks'))['jukebox:before-play']));"));
    await waitLog("jukebox-probe", "probe ");
    const [probe] = await logs("jukebox-probe", "probe ");
    check("a plugin's hook keeps the time limit its manifest gives", probe === 'probe {"mode":"serial","description":"Before a song plays. Return { block } to stop it.","timeoutMs":2000,"onFailure":"open"}', `${probe} (${spec.ok})`);
    await uninstall("jukebox-probe");

    // Removed, the hook goes; the listener waits, and hears it again when the plugin comes back.
    await uninstall("jukebox");
    const gone = await a.evaluate(() => window.__host.command("reference").then((r) => !r.data.plugins.some((p) => p.defines.includes("jukebox:played"))));
    await install(jukebox);
    check("a plugin's hooks go with it, and come back with it", gone && (await waitLog("hook-listener", "listener-heard first", 2)), String(gone));

    // The manifest's hooks are checked before any code runs.
    const refused = async (hooks, id = "bad-hooks") => (await install(`export const manifest = { id: '${id}', name: 'Bad', permissions: [], hooks: ${hooks} };\nexport default () => {};`)).error ?? "installed";
    const mode = await refused("{ open: { mode: 'shout' } }");
    const slow = await refused("{ open: { mode: 'serial', timeoutMs: 60000 } }");
    const tells = await refused("{ open: { mode: 'emit', timeoutMs: 100 } }");
    const kernel = await refused("{ wake: { mode: 'emit' } }", "agent");
    const key = await refused("{ 'Open Now': { mode: 'emit' } }");
    check(
      "a manifest's hooks are refused with a bad mode, a long time limit, a limit on a hook that only tells, a kernel's prefix or a bad key",
      /mode is one of/.test(mode) && /up to 5000/.test(slow) && /for hooks that wait/.test(tells) && /(kernel's|reserved)/.test(kernel) && /keys are lowercase/.test(key),
      [mode, slow, tells, kernel, key].join(" | "),
    );
  } finally {
    for (const id of ["jukebox", "hook-listener", "jukebox-probe", "bad-hooks"]) await uninstall(id);
  }
}
