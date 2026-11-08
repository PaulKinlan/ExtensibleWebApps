// The spending demo: templates fill holes as text, readers redraw, and an element runs its inline script.
// The runner (tests/platform.test.mjs) opens demos/spending/app.html, checks every
// plugin it links draws, then calls this with that page and the shared helpers.
export default async function (page, { check }) {
  // Readers redraw once the owner has added its samples: the budget counts every expense.
  // expenses.html fills {{e.item}} as text: markup typed into the form shows as written.
  await page.fill('[data-key="expenses:list"] input[name="item"]', "<b>Tea</b>");
  await page.fill('[data-key="expenses:list"] input[name="amount"]', "3");
  await page.click('[data-key="expenses:list"] button[type="submit"]');
  await page.waitForSelector('[data-key="expenses:list"] td >> text=<b>Tea</b>', { timeout: 8000 }).catch(() => {});
  const templateText = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('[data-key="expenses:list"] tbody td:first-child')];
    return { shown: cells.some((td) => td.textContent.includes("<b>Tea</b>")), bold: !!document.querySelector('[data-key="expenses:list"] tbody b'), rows: cells.length };
  });
  const spentItems = await page.waitForSelector('[data-key="budget:month"] ui-stat[delta="5 items"]', { timeout: 8000 }).then(() => true, () => false);
  // ui-grid's behaviour is a script inline in elements/ui-grid.html.
  await page.waitForFunction(() => document.querySelector('[data-key="budget:month"] ui-grid')?.shadowRoot?.getElementById("min")?.textContent, null, { timeout: 5000 }).catch(() => {});
  const gridMin = await page.evaluate(() => document.querySelector('[data-key="budget:month"] ui-grid')?.shadowRoot?.getElementById("min")?.textContent);
  check("a plugin that reads another's collection hears its changes and redraws", spentItems);
  check("a view template from an .html file repeats rows and fills holes as text", templateText.shown && !templateText.bold && templateText.rows === 5, JSON.stringify(templateText));
  check("an element with an inline script runs it: ui-grid takes its min width", /--min: 10rem/.test(gridMin ?? ""), gridMin);

  // std/undo.js: Undo takes back the delete, whichever plugin made it, and Redo makes it again.
  const tea = '[data-key="expenses:list"] tbody td >> text=<b>Tea</b>';
  await page.click('[data-key="expenses:list"] button[aria-label="Remove <b>Tea</b>"]');
  await page.waitForSelector(tea, { state: "detached", timeout: 8000 }).catch(() => {});
  const undo = '[data-plugin="undo"] button[data-action="undo"]';
  await page.waitForSelector(`${undo}[title*="delete"]`, { timeout: 8000 }).catch(() => {});
  const title = await page.getAttribute(undo, "title").catch(() => "");
  check("Undo says what it would take back: the delete, in the app's words", title === "Undo: delete “<b>Tea</b>” in Expenses", title);
  await page.click(undo);
  const back = await page.waitForSelector(tea, { timeout: 8000 }).then(() => true, () => false);
  check("Undo puts a deleted expense back, though the undo plugin doesn't own the expenses, with no review", back && !(await page.$('[data-key^="review:"]')));
  const redo = '[data-plugin="undo"] button[data-action="redo"]';
  await page.waitForSelector(`${redo}:not([disabled])`, { timeout: 8000 }).catch(() => {});
  await page.click(redo);
  const gone = await page.waitForSelector(tea, { state: "detached", timeout: 8000 }).then(() => true, () => false);
  check("Redo deletes it again", gone);
  await page.click(undo);
  await page.waitForSelector(tea, { timeout: 8000 }).catch(() => {});
}
