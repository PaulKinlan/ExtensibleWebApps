// Services a sandboxed plugin provides (src/kernel/provided.ts, docs/layers.md):
// declared in the manifest's `provides` with provide:<name>, answered with
// ctx.provide, called like any service by plugins with the permission, listed
// in the API reference, and never able to take a name that is already there.

export default async function ({ a, check, openTab, URL }) {
  const install = (src) => a.evaluate((source) => window.__host.command("install", source), src);
  const uninstall = (id) => a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
  const logs = (id, prefix) => a.evaluate(([i, p]) => window.__host.traces.filter((e) => e.plugin === i && e.detail?.startsWith(p)).map((e) => e.detail), [id, prefix]);
  const waitLog = (id, prefix) => a.waitForFunction(([i, p]) => window.__host.traces.some((e) => e.plugin === i && e.detail?.startsWith(p)), [id, prefix], { timeout: 8000 }).then(() => true, () => false);

  const mailer = `export const manifest = { id: 'mailer', name: 'Mailer', permissions: ['provide:mail'], services: ['mail'], provides: {
  mail: { description: 'Sends mail, for this test.', methods: {
    send: { args: '({ to, subject })', returns: '{ sent, by }', description: 'Sends one message.', params: [{ name: 'message', schema: { type: 'object', required: ['to'], properties: { to: { type: 'string' }, subject: { type: 'string' } } } }] },
    fail: { args: '()', returns: 'nothing', description: 'Always throws.' },
  } },
} };
export default (ctx) => ctx.provide('mail', {
  send: (message, { caller }) => ({ sent: message.to, by: caller }),
  fail: () => { throw new Error('the post office is shut'); },
});`;

  try {
    // The caller installs first and needs mail: the provider isn't there yet, so it is refused.
    const early = await install(`export const manifest = { id: 'early-sender', name: 'Early sender', permissions: ['mail'], services: ['mail'] };\nexport default () => {};`);
    check("a plugin that needs a service no one provides yet is refused", early.ok === false && /mail/.test(early.error ?? ""), early.error);

    const provided = await install(mailer);
    check("a plugin can provide a service", provided.ok === true, JSON.stringify(provided));

    await install(`export const manifest = { id: 'sender', name: 'Sender', permissions: ['mail'], services: ['mail'] };
export default async (ctx) => {
  ctx.log('sent ' + JSON.stringify(await ctx.call('mail', 'send', { to: 'sam@example.com', subject: 'Hi' })));
  ctx.log('failed ' + await ctx.call('mail', 'fail').then(() => 'no', (e) => e.message));
  ctx.log('unknown ' + await ctx.call('mail', 'post').then(() => 'no', (e) => e.message));
};`);
    await waitLog("sender", "unknown ");
    const sent = (await logs("sender", "sent "))[0] ?? "";
    check("another plugin calls it like any service, and the provider hears who called", sent === 'sent {"sent":"sam@example.com","by":"sender"}', sent);
    const failed = (await logs("sender", "failed "))[0] ?? "";
    check("a provider that throws fails the call with its message", /post office is shut/.test(failed), failed);
    const unknown = (await logs("sender", "unknown "))[0] ?? "";
    check("a method the manifest doesn't list can't be called", /not a method/.test(unknown), unknown);

    await install(`export const manifest = { id: 'nosy', name: 'Nosy', permissions: [] };
export default async (ctx) => ctx.log('nosy ' + await ctx.call('mail', 'send', { to: 'x' }).then(() => 'sent', (e) => e.message));`);
    await waitLog("nosy", "nosy ");
    const nosy = (await logs("nosy", "nosy "))[0] ?? "";
    check("calling it needs the service's permission", nosy !== "nosy sent", nosy);

    await install(`export const manifest = { id: 'mail-agent', name: 'Mail agent', permissions: ['mail'] };
export default async (ctx) => {
  const tools = await ctx.call('tools', 'list');
  ctx.log('tools ' + tools.map((t) => t.name).filter((n) => n.startsWith('mail_')).join(','));
  ctx.log('tool-call ' + JSON.stringify(await ctx.call('tools', 'call', 'mail_send', { message: { to: 'kim@example.com' } })));
};`);
    await waitLog("mail-agent", "tool-call ");
    const tools = [...(await logs("mail-agent", "tools ")), ...(await logs("mail-agent", "tool-call "))].join(" ");
    check("a provided method with params is a tool an agent can call, and one without isn't", /tools mail_send(\s|$)/.test(tools) && /kim@example\.com/.test(tools), tools);

    const reference = await a.evaluate(() => window.__host.command("reference"));
    check("the API reference lists the provided service and its methods", /Sends mail, for this test/.test(reference.live) && /Sends one message/.test(reference.live));

    const clash = await install(mailer.replace("id: 'mailer', name: 'Mailer'", "id: 'mailer-two', name: 'Mailer two'"));
    check("a second plugin can't provide a service another already does", clash.ok === false && /mailer already does/.test(clash.error ?? ""), clash.error);
    const kernels = await install(`export const manifest = { id: 'data-thief', name: 'Data thief', permissions: ['provide:data'], provides: { data: { description: 'Not the real one.', methods: { get: { description: 'Pretends.' } } } } };\nexport default () => {};`);
    check("a plugin can't provide a service the kernel has", kernels.ok === false && /kernel already has/.test(kernels.error ?? ""), kernels.error);
    const unasked = await install(`export const manifest = { id: 'unasked', name: 'Unasked', permissions: [], provides: { fax: { description: 'Faxes.', methods: { send: { description: 'Sends a fax.' } } } } };\nexport default () => {};`);
    check("providing a service needs provide:<name>", unasked.ok === false && /provide:fax/.test(unasked.error ?? ""), unasked.error);

    // `service:<name>` is how ctx.provide reaches the kernel, so no plugin may name its own hooks that way.
    const named = await install(`export const manifest = { id: 'service', name: 'Service', permissions: [], hooks: { ping: { mode: 'emit' } } };\nexport default () => {};`);
    check("a plugin can't define hooks named service:…", named.ok === false && /kernel's/.test(named.error ?? ""), named.error);

    await uninstall("mailer");
    const gone = await a.evaluate(() => window.__host.command("reference"));
    check("uninstalling the provider takes its service away", !/Sends mail, for this test/.test(gone.live));
  } finally {
    for (const id of ["sender", "nosy", "mailer", "early-sender", "mailer-two", "data-thief", "unasked", "mail-agent", "service", "pigeon-post", "pigeon-reader"]) await uninstall(id);
  }

  // Plugins opened together count each other's services while they start. If the provider is then refused, the
  // plugin that was waiting for it is stopped too, saying why, rather than left running without the service.
  const app = "demos/contacts";
  const page = await openTab(`${URL}${app}/app.html`);
  const command = (name, arg) => page.evaluate(([name, arg]) => window.__host.command(name, arg), [name, { app, ...arg }]);
  try {
    await command("user:add", { files: [{ name: "pigeon-post.js", data: `export const manifest = { id: 'pigeon-post', name: 'Pigeon post', permissions: ['provide:pigeons'], services: ['carrier-pigeon-feed'], provides: { pigeons: { description: 'Pigeons.', methods: { fly: { description: 'Flies.' } } } } };\nexport default (ctx) => ctx.provide('pigeons', { fly: () => 'flown' });` }] });
    await command("user:add", { files: [{ name: "pigeon-reader.js", data: `export const manifest = { id: 'pigeon-reader', name: 'Pigeon reader', permissions: ['pigeons'], services: ['pigeons'] };\nexport default () => {};` }] });
    await command("user:on", { id: "pigeon-post" });
    await command("user:on", { id: "pigeon-reader" });
    const refused = await page
      .waitForFunction(() => window.__host.traces.some((e) => e.name === "plugin:refused" && e.plugin === "pigeon-reader"), null, { timeout: 8000 })
      .then(() => page.evaluate(() => window.__host.traces.filter((e) => e.name === "plugin:refused" && e.plugin === "pigeon-reader").map((e) => e.detail).join(" ")), () => "");
    const running = await page.evaluate(() => window.__host.command("reference").then((r) => r.data.plugins.map((p) => p.id)));
    check("a plugin waiting for a service whose provider is refused is stopped too, saying which", /pigeons/.test(refused) && !running.includes("pigeon-reader"), `${refused} · running: ${running.includes("pigeon-reader")}`);
  } finally {
    for (const id of ["pigeon-reader", "pigeon-post"]) await command("user:remove", { id }).catch(() => {});
    await page.close({ runBeforeUnload: true });
  }
}
