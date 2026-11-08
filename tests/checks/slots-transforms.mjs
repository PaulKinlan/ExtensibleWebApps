// Slots a plugin declares in its view, which other plugins fill, and view
// transforms: places inside another plugin's views (docs/guide/slots-and-transforms.md).
// The recipes demo's cookbook declares cookbook.recipe.actions and timer.js fills it;
// the contacts demo's next-meeting.js adds a line to each row of the birthdays view.
export default async function ({ a, check, openTab, URL }) {
  // Manifests: a transform needs the permission for the plugin it changes.
  const noPermission = await a.evaluate(() => window.__host.command("install", 'export const manifest = { id: "t1", name: "T", permissions: ["ui"], places: { x: { in: "birthdays", at: "li", put: "append" } } };\nexport default () => {};'));
  check("a place inside another plugin's views needs ui:transform:<plugin>", noPermission.ok === false && /ui:transform:birthdays/.test(noPermission.error), noPermission.error);
  const self = await a.evaluate(() => window.__host.command("install", 'export const manifest = { id: "t2", name: "T", permissions: ["ui", "ui:transform:t2"], places: { x: { in: "t2", at: "li", put: "append" } } };\nexport default () => {};'));
  check("a plugin can't point a transform at its own views", self.ok === false && /own views/.test(self.error), self.error);

  const page = await openTab(`${URL}demos/recipes/app.html`);
  const book = '[data-key="cookbook:cookbook"]';
  await page.click(`${book} ui-table >> text=Pancakes`, { timeout: 8000 });
  const slot = `${book} slot[name="cookbook.recipe.actions"]`;
  const button = await page.waitForSelector(`${slot} button >> text=Start a 20 minute timer`, { timeout: 8000 }).then(() => true, () => false);
  // Redrawing the cookbook (a new serving count) morphs its view: the filled slot keeps the timer's button.
  await page.fill(`${book} input[data-action=serves]`, "6");
  await page.press(`${book} input[data-action=serves]`, "Tab");
  await page.waitForSelector(`${book} li >> text=300 g flour`, { timeout: 5000 }).catch(() => {});
  const kept = (await page.$$(`${slot} button`)).length;
  await page.click(`${slot} button`);
  const started = await page.waitForSelector('[data-key^="timer:countdown"] >> text=Pancakes', { timeout: 5000 }).then(() => true, () => false);
  // Another recipe: the slot's data changes, and the timer draws for its time.
  await page.click(`${book} button >> text=All recipes`);
  await page.click(`${book} ui-table >> text=Lentil curry`, { timeout: 5000 });
  const next = await page.waitForSelector(`${slot} button >> text=Start a 45 minute timer`, { timeout: 5000 }).then(() => true, () => false);
  check("a plugin fills a slot another plugin declares, per slot, and keeps it through redraws", button && kept === 1 && started && next, JSON.stringify({ button, kept, started, next }));
  await page.close();

  const contacts = await openTab(`${URL}demos/contacts/app.html`);
  const rows = '[data-key^="birthdays:"] li[data-name]';
  await contacts.waitForSelector(rows, { timeout: 8000 });
  const lines = await contacts
    .waitForFunction((sel) => {
      const all = [...document.querySelectorAll(sel)];
      return all.length && all.every((li) => li.querySelector('.place [data-key^="next-meeting:"]')) && all.length;
    }, rows, { timeout: 8000 })
    .then((h) => h.jsonValue(), () => 0);
  // A new contact with a birthday tomorrow: birthdays draws again, and the transform follows its rows.
  const people = '[data-key^="people:"] ui-form';
  await contacts.fill(`${people} input[name=name]`, "Ada Lovelace");
  const tomorrow = new Date(Date.now() + 86400000);
  await contacts.fill(`${people} input[name=birthday]`, `1990-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`);
  await contacts.click(`${people} button[type=submit]`);
  const after = await contacts
    .waitForFunction(({ sel, n }) => {
      const all = [...document.querySelectorAll(sel)];
      return all.length === n + 1 && all.every((li) => li.querySelectorAll('.place [data-key^="next-meeting:"]').length === 1) && all.length;
    }, { sel: rows, n: lines }, { timeout: 8000 })
    .then((h) => h.jsonValue(), () => 0);
  check("a view transform adds to each row of another plugin's view, and follows it as it redraws", lines > 0 && after === lines + 1, JSON.stringify({ lines, after }));
  await contacts.close();
}
