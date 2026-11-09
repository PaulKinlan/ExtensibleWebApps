// The homepage links std plugins that carry a place for pages with no slot
// for them (the switchboard, the debug console, the editor and others). The
// homepage has a slot of each name, so the place isn't needed: it used to be
// tried anyway and report "matches nothing" as page:place errors on the debug
// badge. And a place `at: "body"` (the debug console's) never matched, since
// only elements below the body were looked at.

export default async function ({ check, openTab, URL }) {
  const home = await openTab(URL);
  const tab = await home.evaluate(() => window.__host.tab);
  await home.waitForFunction(() => window.__host.places().some((p) => p.plugin === "debug-console"), null, { timeout: 15000 }).catch(() => {});
  // Long enough for every linked plugin to have started and had its places tried.
  await home.waitForTimeout(1500);
  const errors = await home.evaluate((t) => window.__host.traces.filter((e) => e.kind === "error" && e.name.startsWith("page:") && e.detail?.startsWith(`tab ${t}:`)).map((e) => e.detail), tab);
  check("the homepage reports no page errors as it opens (no page:place on the debug badge)", errors.length === 0, errors.join(" | ").slice(0, 400));
  const states = await home.evaluate(() => Object.fromEntries(window.__host.places().filter((p) => ["debug-console", "switchboard"].includes(p.plugin)).map((p) => [`${p.plugin}/${p.name}`, p.state])));
  check("a place whose name the page has a slot for is left to the slot", states["debug-console/debug"] === "slot" && states["switchboard/switchboard"] === "slot", JSON.stringify(states));
  await home.close();

  // A page with no debug slot: the debug console's place appends to the body itself.
  const app = "demos/trip";
  const trip = await openTab(`${URL}${app}/app.html`);
  try {
    const added = await trip.evaluate((app) => window.__host.command("user:add", { app, url: "/std/debug-console.js" }), app);
    await trip.evaluate((app) => window.__host.command("user:on", { app, id: "debug-console" }), app);
    const drawn = await trip.waitForFunction(() => document.querySelector('body > .place[data-place="debug-console/debug"]')?.childElementCount > 0, null, { timeout: 8000 }).then(() => true, () => false);
    const state = await trip.evaluate(() => window.__host.places().find((p) => p.plugin === "debug-console")?.state);
    check("a place at the body itself is found, and draws there", drawn && state === "drawn", JSON.stringify({ added, state }));
  } finally {
    await trip.evaluate((app) => window.__host.command("user:remove", { app, id: "debug-console" }), app).catch(() => {});
    await trip.close();
  }
}
