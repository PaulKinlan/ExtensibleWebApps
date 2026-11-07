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
}
