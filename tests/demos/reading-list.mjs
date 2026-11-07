// The reading-list demo: a plugin writes another plugin's collection through review.
// The runner (tests/platform.test.mjs) opens demos/reading-list/app.html, checks every
// plugin it links draws, then calls this with that page and the shared helpers.
export default async function (page, { check }) {
  // book-import writes to a collection it doesn't own: the review card shows in the app, and the book lands once accepted.
  await page.fill('[data-key="book-import:form"] textarea[name="list"]', "Middlemarch by George Eliot");
  await page.click('[data-key="book-import:form"] button[type="submit"]');
  await page.waitForSelector('[data-key^="review:"] >> text=Accept', { timeout: 8000 });
  await page.click('[data-key^="review:"] >> text=Accept');
  const importedBook = await page.waitForSelector('[data-key="library:books"] ui-table >> text=Middlemarch', { timeout: 8000 }).then(() => true, () => false);
  check("a plugin in an app writing another plugin's collection is reviewed in that app, then lands", importedBook);
}
