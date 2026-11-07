// Places and user plugins: a person adds plugins to apps that left no slot
// for them (demos/trip, demos/menu, demos/invoice) and to one that has slots
// (demos/reading-list), and the author's open, review and locked marks hold.
// The plugins are the demos' samples, added as a person would: from a URL on
// the site, into the person's own folder on this device.

export default async function ({ a, check, openTab, URL }) {
  /** Opens an app, adds samples to it, and turns them on. */
  const withSamples = async (app, samples) => {
    const page = await openTab(`${URL}${app}/app.html`);
    for (const s of samples) {
      const added = await page.evaluate(([app, url]) => window.__host.command("user:add", { app, url }), [app, `/${app}/samples/${s}.js`]);
      if (!added?.ok) throw new Error(`${s}: ${added?.error}`);
    }
    return page;
  };
  const turn = (page, app, id, on) => page.evaluate(([app, id, on]) => window.__host.command(on ? "user:on" : "user:off", { app, id }), [app, id, on]);
  const state = (page, plugin, name) => page.evaluate(([p, n]) => window.__host.places().find((x) => x.plugin === p && x.name === n)?.state, [plugin, name]);

  // Manifests: places are checked as data, before any code runs.
  const noUi = await a.evaluate(() => window.__host.command("install", 'export const manifest = { id: "p1", name: "P", permissions: [], places: { x: { at: "main", put: "after" } } };\nexport default () => {};'));
  check("a plugin with places needs the ui permission", noUi.ok === false && /ui permission/.test(noUi.error), noUi.error);
  const badPut = await a.evaluate(() => window.__host.command("install", 'export const manifest = { id: "p2", name: "P", permissions: ["ui"], places: { x: { at: "main", put: "inside" } } };\nexport default () => {};'));
  check("a place's put is one of before, after, prepend, append, replace or hide", badPut.ok === false && /put/.test(badPut.error), badPut.error);

  // The trip: no slots, no plugins, and still a person can add to it.
  const trip = await withSamples("demos/trip", ["countdown", "packing"]);
  check("an app with no slots and no plugins still gets the Customize button", !!(await trip.$(".customize-button")));
  const listed = await trip.evaluate(() => window.__host.command("user:list", { app: "demos/trip" }));
  check("a plugin a person adds starts off, until they turn it on", listed.length === 2 && listed.every((p) => !p.on), JSON.stringify(listed.map((p) => [p.id, p.on])));
  await turn(trip, "demos/trip", "countdown", true);
  const countdown = await trip.waitForSelector('h1 + .place[data-place="countdown/days"] >> text=/to go|Today|Tomorrow|good one/', { timeout: 8000 }).then(() => true, () => false);
  check("a user plugin draws after the heading of a page that has no slot", countdown);
  const image = await trip
    .waitForFunction(() => document.querySelector('.place[data-place="countdown/days"] img')?.naturalWidth > 0, null, { timeout: 5000 })
    .then(() => trip.evaluate(() => new globalThis.URL(document.querySelector('.place[data-place="countdown/days"] img').src).pathname), () => "");
  check("a user plugin's template and image come from the person's own copy, through the service worker", image === "/user/demos/trip/tram.svg", image);
  await turn(trip, "demos/trip", "packing", true);
  await trip.fill('footer .place ui-form input[name=item]', "Sunscreen", { timeout: 8000 }).catch(() => {});
  await trip.click('footer .place ui-form button[type=submit]').catch(() => {});
  const packed = await trip.waitForSelector("footer .place ui-table >> text=Sunscreen", { timeout: 5000 }).then(() => true, () => false);
  check("a user plugin's bound form and table work in a place, with a collection it owns", packed);
  await turn(trip, "demos/trip", "countdown", false);
  const gone = await trip.waitForSelector('.place[data-place="countdown/days"]', { state: "detached", timeout: 5000 }).then(() => true, () => false);
  check("turning a user plugin off takes its place out of the page", gone);
  await trip.close({ runBeforeUnload: true });

  // The menu: replace every match, and hide.
  const menu = await withSamples("demos/menu", ["currency", "quiet"]);
  await turn(menu, "demos/menu", "currency", true);
  await turn(menu, "demos/menu", "quiet", true);
  const converted = await menu
    .waitForFunction(() => document.querySelectorAll('.place[data-place="currency/prices"] [data-key="currency:price"]').length === 6, null, { timeout: 8000 })
    .then(() => menu.evaluate(() => ({ shown: [...document.querySelectorAll('.place[data-place="currency/prices"]')].map((p) => p.textContent.trim()), hidden: [...document.querySelectorAll('[data-part="price"]')].every((p) => p.hidden) })), () => undefined);
  check("a place with each replaces every match with its own view", !!converted && converted.hidden && converted.shown.every((t) => t.startsWith("£")), JSON.stringify(converted));
  const hidden = await menu.waitForFunction(() => document.getElementById("newsletter").hidden, null, { timeout: 5000 }).then(() => true, () => false);
  check("a place can hide part of the page", hidden);
  await turn(menu, "demos/menu", "currency", false);
  await turn(menu, "demos/menu", "quiet", false);
  const restored = await menu
    .waitForFunction(() => !document.querySelector(".place") && [...document.querySelectorAll('[data-part="price"]')].every((p) => !p.hidden) && !document.getElementById("newsletter").hidden, null, { timeout: 5000 })
    .then(() => true, () => false);
  check("turning the plugins off gives the page back as the author wrote it", restored);
  await menu.close({ runBeforeUnload: true });

  // The invoice: open, review and locked.
  const invoice = await withSamples("demos/invoice", ["memo", "tip", "pay-later"]);
  for (const id of ["memo", "tip", "pay-later"]) await turn(invoice, "demos/invoice", id, true);
  const memo = await invoice.waitForSelector('body > header + .place[data-place="memo/note"] form', { timeout: 8000 }).then(() => true, () => false);
  check("a place in an open area is drawn at once", memo);
  const card = await invoice.waitForSelector('[data-key^="review:"] >> text=Add a tip wants to change', { timeout: 8000 }).then(() => true, () => false);
  const tipBefore = await invoice.$('#lines .place[data-place="tip/line"]');
  check("a place in an area marked review waits for the person, on a card", card && !tipBefore);
  await invoice.click('[data-key^="review:"] button:has-text("Allow")');
  const tip = await invoice.waitForSelector('#lines .place[data-place="tip/line"] >> text=Tip (10%)', { timeout: 5000 }).then(() => true, () => false);
  check("once the person allows it, the place is drawn", tip);
  const locked = await invoice.waitForFunction(() => window.__host.places().find((p) => p.plugin === "pay-later")?.state === "locked", null, { timeout: 5000 }).then(() => true, () => false);
  check("a place in a locked area is refused, and the pay button stays", locked && !(await invoice.$eval("#pay", (el) => el.hidden)));
  await invoice.evaluate(() => window.__host.command("place:unlock", { app: "demos/invoice", plugin: "pay-later", place: "pay" }));
  const unlocked = await invoice.waitForSelector('.place[data-place="pay-later/pay"] >> text=Pay on 30 May', { timeout: 5000 }).then(() => true, () => false);
  check("the person can unlock a locked area for one plugin", unlocked && (await invoice.$eval("#pay", (el) => el.hidden)) && (await state(invoice, "pay-later", "pay")) === "drawn");
  await invoice.close({ runBeforeUnload: true });

  // The reading list: slots for its own plugins, a place for the person's.
  const reading = await withSamples("demos/reading-list", ["goal"]);
  await turn(reading, "demos/reading-list", "goal", true);
  const goal = await reading.waitForSelector('main > .place:first-child[data-place="goal/goal"] >> text=books read this year', { timeout: 8000 }).then(() => true, () => false);
  const slotted = await reading.waitForSelector('slot[name="main"] [data-key^="library:"]', { state: "attached", timeout: 5000 }).then(() => true, () => false);
  check("a user plugin's place sits beside the app's slots, reading another plugin's collection", goal && slotted);
  await turn(reading, "demos/reading-list", "goal", false);
  await reading.close({ runBeforeUnload: true });

  // Plugins can't add plugins: the person's folder belongs to the platform.
  const sneaky = await a.evaluate(() => window.__host.command("user:add", { app: "../x", files: [{ name: "x.js", data: "export const manifest = { id: 'x', name: 'X', permissions: [] };" }] }));
  check("an app folder that climbs out is refused", sneaky?.ok === false && /app folder/.test(sneaky.error), JSON.stringify(sneaky));
}
