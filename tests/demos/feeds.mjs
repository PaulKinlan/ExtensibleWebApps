// The feed reader outside a space: following a feed works, it says the feeds
// are read by a server, and a feed waits to be read (tests/server/run.mjs
// checks the reading, on a space's server).
export default async function (page, { check, proof }) {
  const view = '[data-plugin="feeds"][data-key="feeds:feeds"]';
  await page.waitForSelector(`${view} ui-form`, { timeout: 8000 });
  proof.note = await page.locator(`${view} .note`).count();
  await page.fill(`${view} ui-form input[name=url]`, "https://example.com/feed.xml");
  await page.click(`${view} ui-form button[type=submit]`);
  proof.followed = await page.waitForSelector(`${view} .feed:has-text("example.com/feed.xml") .state:has-text("Not read yet")`, { timeout: 5000 }).then(() => true, () => false);
  check("the feed reader follows a feed by its address, says it isn't read yet, and that feeds are read by a server", proof.followed && proof.note === 1, JSON.stringify({ followed: proof.followed, note: proof.note }));
}
