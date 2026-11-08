// The reading-list demo: a plugin writes another plugin's collection through review.
// The runner (tests/platform.test.mjs) opens demos/reading-list/app.html, checks every
// plugin it links draws, then calls this with that page and the shared helpers.
export default async function (page, { check, openTab, URL }) {
  // book-import writes to a collection it doesn't own: the review card shows in the app, and the book lands once accepted.
  await page.fill('[data-key="book-import:form"] textarea[name="list"]', "Middlemarch by George Eliot");
  await page.click('[data-key="book-import:form"] button[type="submit"]');
  await page.waitForSelector('[data-key^="review:"] >> text=Accept', { timeout: 8000 });
  await page.click('[data-key^="review:"] >> text=Accept');
  const importedBook = await page.waitForSelector('[data-key="library:books"] ui-table >> text=Middlemarch', { timeout: 8000 }).then(() => true, () => false);
  check("a plugin in an app writing another plugin's collection is reviewed in that app, then lands", importedBook);

  // The router: a book has a screen of its own, at #/book/<id>, that back leaves and a new tab opens.
  const books = await page.evaluate(() => fetch("books.json").then((r) => r.json()));
  const dune = books.find((b) => b.title === "Dune");
  const card = '[data-key^="book-page@"] ui-card';
  await page.evaluate((id) => (location.hash = `#/book/${id}`), dune.id);
  const shown = await page.waitForSelector(`${card} >> text=Frank Herbert`, { timeout: 8000 }).then(() => true, () => false);
  check("an address's #/book/<id> shows that book's screen", shown);
  await page.goBack();
  const left = await page.waitForSelector(card, { state: "detached", timeout: 8000 }).then(() => true, () => false);
  check("back leaves the book's screen", left && !page.url().includes("#/book/"), page.url());
  const fresh = await openTab(`${URL}demos/reading-list/app.html#/book/${dune.id}`);
  const deep = await fresh.waitForSelector(`${card} >> text=Frank Herbert`, { timeout: 8000 }).then(() => true, () => false);
  check("a link to a book's screen opens it in a new tab", deep);
  const link = await fresh.$(`${card} a[href="#/"]`);
  check("a link to another screen opens in the same tab", !!link && !(await link.getAttribute("target")));
  await link?.click();
  const back = await fresh.waitForSelector(card, { state: "detached", timeout: 8000 }).then(() => true, () => false);
  check("following a link to #/ goes back to the list", back && fresh.url().endsWith("#/"), fresh.url());
  await fresh.close({ runBeforeUnload: true });
}
