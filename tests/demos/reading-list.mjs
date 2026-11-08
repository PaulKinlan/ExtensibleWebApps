// The reading-list demo: a plugin writes another plugin's collection through review.
// The runner (tests/platform.test.mjs) opens demos/reading-list/app.html, checks every
// plugin it links draws, then calls this with that page and the shared helpers.
export default async function (page, { check, openTab, URL, context }) {
  // book-import writes to a collection it doesn't own: the review card shows in the app, and the book lands once accepted.
  await page.fill('[data-key="book-import:form"] textarea[name="list"]', "Middlemarch by George Eliot");
  await page.click('[data-key="book-import:form"] button[type="submit"]');
  await page.waitForSelector('[data-key^="review:"] >> text=Accept', { timeout: 8000 });
  await page.click('[data-key^="review:"] >> text=Accept');
  const importedBook = await page.waitForSelector('[data-key="library:books"] ui-table >> text=Middlemarch', { timeout: 8000 }).then(() => true, () => false);
  check("a plugin in an app writing another plugin's collection is reviewed in that app, then lands", importedBook);

  // The router: a book has a screen of its own, at book/<id>, which a new tab opens, a link leaves without
  // loading the page, and back returns to.
  const books = await page.evaluate(() => fetch("books.json").then((r) => r.json()));
  const dune = books.find((b) => b.title === "Dune");
  const card = '[data-key^="book-page@"] ui-card';
  const fresh = await openTab(`${URL}demos/reading-list/book/${dune.id}`);
  const deep = await fresh.waitForSelector(`${card} >> text=Frank Herbert`, { timeout: 8000 }).then(() => true, () => false);
  check("a book's address, /demos/reading-list/book/<id>, opens the app at that book's screen", deep);
  // A view waits for its elements before it is drawn (src/host/main.ts), so the library's may come a moment after the card.
  const views = '[data-key^="library:"], [data-key^="due-soon:"]';
  await fresh.waitForFunction((s) => document.querySelectorAll(s).length >= 2, views, { timeout: 8000 }).catch(() => {});
  const drawn = await fresh.$$eval(views, (els) => els.length);
  check("the app's relative links still load its plugins when it opens at a screen", drawn >= 2, `${drawn} views`);
  await fresh.evaluate(() => (window.__stayed = true));
  const link = await fresh.$(`${card} a[href="./"]`);
  check("a link to another screen of the app opens in the same tab", !!link && !(await link.getAttribute("target")));
  await link?.click();
  const left = await fresh.waitForSelector(card, { state: "detached", timeout: 8000 }).then(() => true, () => false);
  check("following a link to the app's own address goes back to the list, without loading the page", left && fresh.url() === `${URL}demos/reading-list/` && (await fresh.evaluate(() => window.__stayed === true)), fresh.url());
  await fresh.goBack();
  const returned = await fresh.waitForSelector(`${card} >> text=Frank Herbert`, { timeout: 8000 }).then(() => true, () => false);
  check("back returns to the book's screen, without loading the page", returned && (await fresh.evaluate(() => window.__stayed === true)));
  await fresh.goto(`${URL}demos/reading-list/book/%E0%A4%A`);
  const odd = await fresh.waitForSelector(`${card} >> text=isn't in the library`, { timeout: 8000 }).then(() => true, () => false);
  check("an address that isn't a book's id says so", odd);

  // The share service, sending: Share on a book's screen hands its address to the system's share sheet.
  await fresh.goto(`${URL}demos/reading-list/book/${dune.id}`);
  await fresh.waitForSelector(`${card} button[data-action="share"]`, { timeout: 8000 }).catch(() => {});
  await fresh.evaluate(() => (navigator.share = async (data) => void (window.__shared = data)));
  await fresh.click(`${card} button[data-action="share"]`);
  await fresh.waitForSelector(`${card} [role="status"] >> text=Shared`, { timeout: 8000 }).catch(() => {});
  const sent = await fresh.evaluate(() => window.__shared);
  check("Share hands the book's title and whole address to the share sheet", sent?.title === "Dune" && sent?.text === "Dune by Frank Herbert" && sent?.url === `${URL}demos/reading-list/book/${encodeURIComponent(dune.id)}`, JSON.stringify(sent));

  // Receiving: the manifest's share_target opens the app at share?title=…&url=…, and book-share.js adds the page as a book, after review.
  const manifest = await fresh.evaluate(() => fetch(document.querySelector('link[rel="manifest"]').href).then((r) => r.json()));
  check("the reading list's manifest makes it a share target, at its share screen", manifest.share_target?.action === "share" && manifest.share_target?.method === "GET", JSON.stringify(manifest.share_target));
  await fresh.goto(`${URL}demos/reading-list/share?title=${encodeURIComponent("Station Eleven")}&url=${encodeURIComponent("https://example.com/station-eleven")}`);
  const review = '[data-key^="review:"]';
  await fresh.waitForSelector(`${review} >> text=Station Eleven`, { timeout: 8000 }).catch(() => {});
  const shownReview = (await fresh.textContent(review).catch(() => "")) ?? "";
  check("a page shared to the app is offered as a book, with its link in the notes, for review", shownReview.includes("Station Eleven") && shownReview.includes("https://example.com/station-eleven"), shownReview.slice(0, 200));
  await fresh.click(`${review} >> text=Accept`).catch(() => {});
  const added = await fresh.waitForSelector('[data-key="library:books"] ui-table >> text=Station Eleven', { timeout: 8000 }).then(() => true, () => false);
  check("once accepted it is in the library, and the tab is back at the app's own address", added && fresh.url() === `${URL}demos/reading-list/`, fresh.url());
  await fresh.reload();
  await fresh.waitForSelector('[data-key="library:books"] ui-table', { timeout: 8000 }).catch(() => {});
  const twice = await fresh.$$eval('[data-key="library:books"] ui-table >> text=Station Eleven', (els) => els.length).catch(() => -1);
  check("reloading doesn't share it again", twice === 1 && !(await fresh.$(review)), `${twice} rows`);
  await fresh.close({ runBeforeUnload: true });

  // Someone opening a shared link has no service worker yet: the server's 404.html starts it and loads the address again.
  const stranger = await context.browser().newContext();
  try {
    const first = await stranger.newPage();
    const status = await first.goto(`${URL}demos/reading-list/book/a-book-added-elsewhere`).then((r) => r?.status());
    // A new browser has its own data (the sample books, but not what someone added): the book's screen opens, and says this library hasn't got it.
    const opened = await first.waitForSelector(`${card} >> text=isn't in the library`, { timeout: 15000 }).then(() => true, () => false);
    check("a first visit to a screen's address gets the server's 404.html, which starts the service worker and opens the app there", status === 404 && opened, `first answer ${status}`);
    await first.goto(`${URL}no-such-place/at-all`);
    const nothing = await first.waitForSelector("text=There's nothing at this address", { timeout: 8000 }).then(() => true, () => false);
    check("an address with no app above it says there's nothing there", nothing);
  } finally {
    await stranger.close();
  }
}
