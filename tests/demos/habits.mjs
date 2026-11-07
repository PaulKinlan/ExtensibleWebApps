// The habits demo: the guide's app adds a habit, ticks it, and shows its streak.
// The runner (tests/platform.test.mjs) opens demos/habits/app.html, checks every
// plugin it links draws, then calls this with that page and the shared helpers.
export default async function (page, { check, proof }) {
  // The guide's app: add a habit with the form, tick it, and the live list shows the streak.
  const view = '[data-key="habits:habits"]';
  await page.fill(`${view} ui-form input[name=name]`, "Stretch");
  await page.click(`${view} ui-form button[type=submit]`);
  await page.check(`${view} input[type=checkbox]`, { timeout: 5000 });
  proof.habit = await page.waitForSelector(`${view} li[data-done] >> text=1 day`, { timeout: 5000 }).then(() => true, () => false);
  check("the guide's habits app adds a habit, ticks it, and shows its streak", proof.habit);
}
