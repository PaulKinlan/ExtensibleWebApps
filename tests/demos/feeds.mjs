// The feed reader outside a space: following a feed works with no sign-in, it
// offers a space in one line rather than asking for one first, and the feed
// is tried on this device: this test's server (vite preview) has no feed
// reader, so read-here.js must say so on the feed, which shows it ran.
// tests/server/run.mjs checks the reading itself, on both hosts.
export default async function (page, { check, proof }) {
  const view = '[data-plugin="feeds"][data-key="feeds:feeds"]';
  await page.waitForSelector(`${view} ui-form`, { timeout: 8000 });
  proof.note = await page.locator(`${view} .note`).count();
  proof.offer = await page.locator(`${view} .share a[href^="/account/"]`).count();
  await page.fill(`${view} ui-form input[name=url]`, "https://example.com/feed.xml");
  await page.click(`${view} ui-form button[type=submit]`);
  proof.followed = await page.waitForSelector(`${view} .feed:has-text("example.com/feed.xml") .error:has-text("feed reader")`, { timeout: 8000 }).then(() => true, () => false);
  check("the feed reader follows a feed by its address with no space, and offers a space in one line instead of asking for one", proof.followed && proof.note === 0 && proof.offer === 1, JSON.stringify({ followed: proof.followed, note: proof.note, offer: proof.offer }));
}
