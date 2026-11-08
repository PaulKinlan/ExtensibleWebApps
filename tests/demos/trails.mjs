// Trails: a year heatmap, a feed of activity cards with their route pictures,
// a filter, and a form that adds to the log, which every view follows.
// The runner (tests/platform.test.mjs) opens demos/trails/app.html, checks every
// plugin it links draws, then calls this with that page and the shared helpers.
export default async function (page, { check, proof }) {
  const year = '[data-key="year:year"]';
  const feed = '[data-key="activities:feed"]';
  await page.waitForSelector(`${feed} .act`, { timeout: 15000 });
  proof.squares = await page.locator(`${year} .days .day`).count();
  proof.levels = await page.locator(`${year} .days .day[data-level="4"]`).count();
  check("the year draws a square a day, darker on bigger days", proof.squares >= 358 && proof.squares <= 371 && proof.levels > 0, `${proof.squares} squares, ${proof.levels} at level 4`);

  // A route picture is an SVG file next to the template: the plugin's own file, loaded with no network permission.
  proof.route = await page.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((img) => img.complete && img.naturalWidth > 0), `${feed} .map img`, { timeout: 5000 }).then(() => true, () => false);
  check("each card shows its route, an image from the plugin's own folder", proof.route);

  await page.click(`${feed} .filters button[data-value="swim"]`);
  proof.swims = await page.waitForFunction((sel) => {
    const kinds = [...document.querySelectorAll(sel)].map((el) => el.dataset.kind);
    return kinds.length > 0 && kinds.every((k) => k === "swim");
  }, `${feed} .act`, { timeout: 5000 }).then(() => true, () => false);
  check("the filter shows only one kind of activity", proof.swims);
  await page.click(`${feed} .filters button[data-value="all"]`);

  // Logging an activity with the bound form puts it at the top of the feed.
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  await page.click(`${feed} details.new summary`);
  const form = `${feed} ui-form`;
  await page.fill(`${form} input[name=title]`, "Test marathon");
  await page.fill(`${form} input[name=date]`, iso);
  await page.fill(`${form} input[name=km]`, "42.2");
  await page.fill(`${form} input[name=minutes]`, "245");
  await page.click(`${form} button[type=submit]`);
  proof.logged = await page.waitForSelector(`${feed} .act >> text=Test marathon`, { timeout: 5000 }).then(() => true, () => false);
  proof.best = await page.waitForSelector('[data-key="bests:bests"] .tile >> text=42.2', { timeout: 5000 }).then(() => true, () => false);
  check("a logged activity lands in the feed, and becomes the longest run", proof.logged && proof.best);
}
