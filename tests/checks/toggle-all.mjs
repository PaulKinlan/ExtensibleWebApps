// Turning everything off and on again never needs a reload. On the homepage, chapter 1 turns every
// plugin off; the page's own "turn everything back on" link (?reset) is a link to the page itself,
// which the router follows without loading it, so the host has to turn the plugins back on in place.
// Turning them back on from another tab has to reach this one too.
//
// It runs in a browser context of its own, so a kernel and data folder of its own.
export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL);
  const key = (id) => `slot :is([data-key^="${id}:"], [data-key^="${id}@"])`;
  const ids = ["learning-notes", "note-stats", "chapter-1-core", "chapter-2-plugins", "switchboard"];
  const allDrawn = (p) => Promise.all(ids.map((id) => p.waitForSelector(key(id), { state: "attached", timeout: 8000 }).then(() => true, () => false))).then((d) => d.every(Boolean));
  const allOff = async () => {
    await page.click('[data-plugin="chapter-1-core"] button[data-action="all-off"]');
    return page.waitForFunction(() => !document.querySelector("slot [data-key]"), null, { timeout: 8000 }).then(() => true, () => false);
  };
  check("the homepage draws before anything is switched", await allDrawn(page));
  // Set on this document: a reload would lose it.
  await page.evaluate(() => (window.__stayed = true));

  const off = await allOff();
  await page.click('slot[name="chapters"] >> text=Turn everything back on');
  const back = await allDrawn(page);
  const stayed = await page.evaluate(() => window.__stayed === true);
  check("turning everything off, then the page's link to turn it back on, brings every view back without a reload", off && back && stayed, `off ${off}, back ${back}, same page ${stayed}`);
  check("the link's ?reset leaves the address once it has done its job", !page.url().includes("reset"), page.url());

  // Again, from another tab: this tab's views come back as soon as the plugins are on.
  const off2 = await allOff();
  const other = await own.newPage();
  await other.goto(`${URL}?reset`);
  const backHere = await allDrawn(page);
  check("everything turned back on in another tab comes back in this one without a reload", off2 && backHere && (await page.evaluate(() => window.__stayed === true)));
  await own.close();
}
