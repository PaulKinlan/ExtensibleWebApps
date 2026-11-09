// What Customize does with the person's own plugins, as the authoring service
// offers it to a plugin (src/kernel/authoring.ts): add one from this site
// after a review, turn it on and off with plugins:manage, refuse what isn't
// from this site or isn't theirs, and in a space only, share it. A probe
// plugin makes the calls and logs what each answered.
const PROBE = `export const manifest = { id: 'customize-probe', name: 'Customize probe', scope: 'tab', permissions: ['plugins:author', 'plugins:manage'] };
export default async (ctx) => {
  const say = (what, value) => ctx.log(what + ' ' + JSON.stringify(value));
  const call = (...args) => ctx.call('authoring', ...args).catch((e) => ({ thrown: String(e.message ?? e) }));
  say('add', await call('add', '/packages/clock/clock.js'));
  say('mine', (await call('mine')).find((p) => p.id === 'clock'));
  say('on', await call('turn', 'clock', true));
  say('mine-on', (await call('mine')).find((p) => p.id === 'clock'));
  say('elsewhere', await call('add', 'https://example.com/plugin.js'));
  say('clash', await call('add', '/demos/trip/samples/countdown.js'));
  say('not-mine', await call('turn', 'contacts', false));
  say('share', await call('share', 'clock'));
  say('remove', await call('remove', 'clock'));
  say('done', true);
};`;

export default async function ({ check, openTab, URL }) {
  const app = "demos/contacts";
  const page = await openTab(`${URL}${app}/app.html`);
  const review = '[data-key^="review:"]';
  /** What the probe logged for a step, once it has. */
  const said = (step, timeout = 15000) =>
    page
      .waitForFunction((step) => window.__host.traces.some((e) => e.plugin?.startsWith("customize-probe") && e.detail?.startsWith(step + " ")), step, { timeout })
      .then(() => page.evaluate((step) => JSON.parse(window.__host.traces.find((e) => e.plugin?.startsWith("customize-probe") && e.detail?.startsWith(step + " ")).detail.slice(step.length + 1)), step), () => undefined);
  const accept = async (text) => {
    const shown = await page.waitForSelector(`${review} >> text=${text}`, { timeout: 15000 }).then(() => true, () => false);
    if (shown) await page.click(`${review} >> text=Accept`);
    return shown;
  };
  try {
    await page.evaluate(([app, data]) => window.__host.command("user:add", { app, files: [{ name: "customize-probe.js", data }] }), [app, PROBE]);
    // One of the person's plugins already lists countdown.html, which Countdown would overwrite.
    const CLASH = `export const manifest = { id: 'clash', name: 'Clash', permissions: [], files: ['countdown.html'] };\nexport default () => {};`;
    await page.evaluate(([app, data]) => window.__host.command("user:add", { app, files: [{ name: "clash.js", data }, { name: "countdown.html", data: "<template id=x></template>" }] }), [app, CLASH]);
    await page.evaluate((app) => window.__host.command("user:on", { app, id: "customize-probe" }), app);

    const reviewed = await accept("adds Clock");
    const added = await said("add");
    check("a plugin adds one from this site to the person's own only after they accept a review of its code", reviewed && added?.ok === true && added.id === "clock", JSON.stringify(added));
    const listed = await said("mine");
    check("it lists the person's own plugins, with what each asks for, and adds a new one off", listed?.on === false && listed.shared === false && listed.permissions?.includes("provide:clock"), JSON.stringify(listed));
    const on = await said("on");
    const nowOn = await said("mine-on");
    check("turning one of the person's own plugins on needs no review", on?.ok === true && nowOn?.on === true, JSON.stringify({ on, nowOn }));
    const elsewhere = await said("elsewhere");
    check("a plugin from another site isn't added", elsewhere?.ok === false && /this site/.test(elsewhere.error), JSON.stringify(elsewhere));
    const clash = await said("clash");
    check("a plugin whose files belong to another of the person's plugins isn't added, before any review", clash?.ok === false && /belongs to Clash/.test(clash.error), JSON.stringify(clash));
    const notMine = await said("not-mine");
    check("turn() switches only the person's own plugins, not the app's", notMine?.ok === false && /isn't one of your plugins/.test(notMine.error), JSON.stringify(notMine));
    const share = await said("share");
    check("outside a space, nothing is shared", share?.ok === false && /space/.test(share.error), JSON.stringify(share));
    const removing = await accept("removes Clock");
    const removed = await said("remove");
    const left = (await page.evaluate((app) => window.__host.command("user:list", { app }), app)).map((p) => p.id);
    check("removing one, after a review, takes it off", removing && removed?.ok === true && !left.includes("clock"), JSON.stringify({ removed, left }));
  } finally {
    for (const id of ["clock", "clash", "customize-probe"]) await page.evaluate(([app, id]) => window.__host.command("user:remove", { app, id }), [app, id]).catch(() => {});
    await page.close({ runBeforeUnload: true });
  }
}
