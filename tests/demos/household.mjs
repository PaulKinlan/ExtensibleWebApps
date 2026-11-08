// The household demo on its own, outside a space: one person says who they
// are, adds to the shopping list, gets it, and does a chore, and the app
// signs each with "you". tests/checks/household-space.mjs shares it between
// two people in a space.
export default async function (page, { check }) {
  const who = '[data-key="housemates:who"]';
  const list = '[data-key="groceries:list"]';
  const chores = '[data-key="chores:list"]';
  await page.fill(`${who} input[name=name]`, "Sam");
  await page.click(`${who} button[type=submit]`);
  const named = await page.waitForSelector(`${who} >> text=You're Sam`, { timeout: 5000 }).then(() => true, () => false);

  await page.fill(`${list} input[name=item]`, "Lemons");
  await page.click(`${list} button[type=submit]`);
  const added = await page.waitForSelector(`${list} li:has-text("Lemons · you added it")`, { timeout: 5000 }).then(() => true, () => false);
  const cleared = (await page.inputValue(`${list} input[name=item]`).catch(() => "?")) === "";
  await page.locator(`${list} li`, { hasText: "Lemons" }).locator("input[type=checkbox]").click();
  const got = await page.waitForSelector(`${list} li:has-text("Lemons · you got it")`, { timeout: 5000 }).then(() => true, () => false);
  check("household: the shopping list signs what this device's person adds and gets, and empties its field after an add", named && added && cleared && got);

  await page.locator(`${chores} li`, { hasText: "Water the plants" }).locator('button:has-text("Done")').click();
  const done = await page.waitForSelector(`${chores} li:has-text("You did it today")`, { timeout: 5000 }).then(() => true, () => false);
  check("household: marking a chore done says who did it and when it's next due", done && (await page.locator(`${chores} li`, { hasText: "Water the plants" }).textContent()).includes("Due in 3 days"));
}
