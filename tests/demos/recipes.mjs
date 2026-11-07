// The recipes demo: scaling a recipe, a shopping list from it, and a form editing a list of groups.
// The runner (tests/platform.test.mjs) opens demos/recipes/app.html, checks every
// plugin it links draws, then calls this with that page and the shared helpers.
export default async function (page, { check, proof }) {
  const book = '[data-key="cookbook:cookbook"]';
  await page.click(`${book} ui-table >> text=Pancakes`);
  await page.waitForSelector(`${book} input[data-action=serves]`, { timeout: 5000 });
  await page.fill(`${book} input[data-action=serves]`, "6");
  await page.press(`${book} input[data-action=serves]`, "Tab");
  await page.waitForSelector(`${book} li >> text=300 g flour`, { timeout: 5000 }).catch(() => {});
  proof.scaled = await page.locator(`${book} ul li`).allTextContents();
  // The shopping list fills from a recipe it reads but doesn't own, then ticks an item off.
  const list = '[data-key="shopping:list"]';
  await page.selectOption(`${list} select`, { label: "Pancakes" });
  await page.click(`${list} button[type=submit] >> text=Add its ingredients`);
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel} input[type=checkbox]`).length === 4, list, { timeout: 5000 }).catch(() => {});
  await page.check(`${list} input[type=checkbox] >> nth=0`);
  proof.ticked = await page.waitForSelector(`${list} s`, { timeout: 5000 }).then(() => true, () => false);
  // ui-form edits a list of groups: add two ingredients, remove one, see an error beside the field it is about, then save.
  await page.click(`${book} button >> text=All recipes`);
  const form = `${book} ui-form`;
  await page.fill(`${form} input[name=title]`, "Toast");
  await page.click(`${form} button.add`);
  await page.click(`${form} button.add`);
  // Add moves focus to the new row's first field.
  proof.focusAfterAdd = await page.evaluate((sel) => document.querySelector(sel).shadowRoot.activeElement?.getAttribute("name"), `${book} ui-form`);
  await page.fill(`${form} input[name="ingredients[1].amount"]`, "2");
  await page.fill(`${form} input[name="ingredients[1].unit"]`, "slices");
  await page.click(`${form} button.add`);
  await page.fill(`${form} input[name="ingredients[2].item"]`, "butter");
  await page.click(`${form} button.remove >> nth=2`);
  proof.rows = await page.locator(`${form} li`).count();
  // Row 0 is blank and left out, so the kernel's error is about ingredients[0]; it shows in row 1, where it came from.
  await page.click(`${form} button[type=submit]`);
  proof.nestedError = await page.waitForSelector(`${form} li[data-row="ingredients[1]"] >> text=item is required`, { timeout: 5000 }).then(() => true, () => false);
  await page.fill(`${form} input[name="ingredients[1].item"]`, "bread");
  await page.click(`${form} button[type=submit]`);
  await page.click(`${book} ui-table >> text=Toast`, { timeout: 5000 });
  await page.waitForSelector(`${book} input[data-action=serves]`, { timeout: 5000 });
  proof.toast = await page.locator(`${book} ul li`).allTextContents();
  check("a recipe scales its ingredients to the servings typed in", JSON.stringify(proof.scaled) === JSON.stringify(["300 g flour", "3 eggs", "450 ml milk", "1.5 pinch salt"]), JSON.stringify(proof.scaled));
  check("a shopping list fills from a recipe and ticks an item off", proof.ticked);
  check("a form edits a list of ingredients: add, remove, an error beside the field, save", proof.focusAfterAdd === "ingredients[1].amount" && proof.rows === 2 && proof.nestedError && JSON.stringify(proof.toast) === JSON.stringify(["2 slices bread"]), JSON.stringify({ focus: proof.focusAfterAdd, rows: proof.rows, error: proof.nestedError, toast: proof.toast }));
}
