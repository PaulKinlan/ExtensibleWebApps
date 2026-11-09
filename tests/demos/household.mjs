// The household demo on its own, outside a space: one person adds to the
// shopping list, gets it, and does a chore, and the app signs each with
// "you". tests/checks/household-space.mjs shares it between
// two people in a space.
export default async function (page, { check }) {
  const who = '[data-key="housemates:who"]';
  const list = '[data-key="groceries:list"]';
  const chores = '[data-key="chores:list"]';
  const named = await page.waitForSelector(`${who} >> text=Just you on this device`, { timeout: 5000 }).then(() => true, () => false);
  const seeded = await page.waitForSelector(`${list} li:has-text("Milk")`, { timeout: 5000 }).then(() => true, () => false);
  check("household: on its own it's one person's list, nobody types a name, and a new household gets its sample items", named && seeded && !(await page.locator(`${who} input`).count()));

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

  // A refused add keeps what was typed, and adds nothing; the next add that's saved empties the form.
  // A guard plugin refuses anything named "Blocked …", as a person's own data:beforeWrite plugin might.
  const guard = `export const manifest = { id: "household-guard", name: "Guard", permissions: ["data:read:groceries", "data:read:chores", "hook:intercept:data:beforeWrite:groceries", "hook:intercept:data:beforeWrite:chores"] };
export default (ctx) => {
  const no = (change) => (/^Blocked/.test(change.after?.item ?? change.after?.name ?? "") ? { block: "Not that" } : undefined);
  ctx.on("data:beforeWrite:groceries", no);
  ctx.on("data:beforeWrite:chores", no);
};`;
  const installed = await page.evaluate((source) => window.__host.command("install", source), guard);
  try {
    await page.fill(`${list} input[name=item]`, "Blocked item");
    await page.click(`${list} button[type=submit]`);
    await page.waitForTimeout(800);
    const keptItem = (await page.inputValue(`${list} input[name=item]`)) === "Blocked item" && !(await page.locator(`${list} li`, { hasText: "Blocked item" }).count());
    await page.fill(`${list} input[name=item]`, "Pears");
    await page.click(`${list} button[type=submit]`);
    const retried = (await page.waitForSelector(`${list} li:has-text("Pears")`, { timeout: 5000 }).then(() => true, () => false)) && (await page.inputValue(`${list} input[name=item]`)) === "";
    check("household: a refused shopping list add keeps what was typed and adds nothing; the next saved add empties the form", installed?.ok !== false && keptItem && retried, JSON.stringify({ installed, keptItem, retried }));

    await page.fill(`${chores} input[name=name]`, "Blocked chore");
    await page.selectOption(`${chores} select[name=every]`, "14");
    await page.click(`${chores} button[type=submit]`);
    await page.waitForTimeout(800);
    const keptChore = (await page.inputValue(`${chores} input[name=name]`)) === "Blocked chore" && (await page.inputValue(`${chores} select[name=every]`)) === "14" && !(await page.locator(`${chores} li`, { hasText: "Blocked chore" }).count());
    await page.fill(`${chores} input[name=name]`, "Mop the floor");
    await page.click(`${chores} button[type=submit]`);
    const choreRetried = (await page.waitForSelector(`${chores} li:has-text("Mop the floor")`, { timeout: 5000 }).then(() => true, () => false)) && (await page.inputValue(`${chores} input[name=name]`)) === "" && (await page.inputValue(`${chores} select[name=every]`)) === "7";
    check("household: a refused chore add keeps its name and how often, and adds nothing; the next saved add resets the form", keptChore && choreRetried, JSON.stringify({ keptChore, choreRetried }));
  } finally {
    await page.evaluate(() => window.__host.command("uninstall", "household-guard")).catch(() => {});
  }
}
