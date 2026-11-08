// Inspect mode (src/host/inspect.ts): the person points at a part of the page, sees which plugin drew
// it, and hides it or adds a note beside it. Each change is a plugin of their own, so Customize lists
// it and turning it off undoes it. Inside a plugin's view the change is a view transform.
export default async function ({ check, openTab, URL }) {
  const page = await openTab(`${URL}demos/contacts/app.html`);
  const row = '[data-key^="birthdays:"] li[data-name]';
  await page.waitForSelector(row, { timeout: 8000 });
  const name = await page.getAttribute(row, "data-name");
  const target = `[data-key^="birthdays:"] li[data-name="${name}"]`;

  // From Customize, as a person would.
  await page.click(".customize-button");
  await page.click("[data-inspect-start]");
  await page.hover(target);
  const told = (await page.textContent("#inspect")) ?? "";
  await page.click(target);
  const picked = await page.$eval(target, (el) => el.classList.contains("inspect-picked"));
  await page.click('#inspect [data-inspect="hide"]');
  const hidden = await page.waitForSelector(`${target}[hidden]`, { state: "attached", timeout: 8000 }).then(() => true, () => false);
  const mine = await page.evaluate(() => window.__host.command("user:list", { app: "demos/contacts" }));
  const made = mine.find((p) => p.id?.startsWith("hide-"));
  check(
    "inspect mode says which plugin drew a part, and hides it with a transform of the person's own",
    /Drawn by birthdays/.test(told) && picked && hidden && made?.on === true && made.permissions.includes("ui:transform:birthdays"),
    JSON.stringify({ told: told.slice(0, 80), picked, hidden, made }),
  );
  // Turning it off gives the row back.
  await page.evaluate((id) => window.__host.command("user:off", { app: "demos/contacts", id }), made?.id);
  const back = await page.waitForSelector(`${target}:not([hidden])`, { timeout: 8000 }).then(() => true, () => false);
  check("turning off what inspect mode made undoes it", back);
  await page.evaluate((id) => window.__host.command("user:remove", { app: "demos/contacts", id }), made?.id);
  await page.keyboard.press("Escape");
  await page.close();

  // On the app's own page: a note after its heading.
  const trip = await openTab(`${URL}demos/trip/app.html`);
  await trip.evaluate(() => window.__host.inspect());
  await trip.click("h1[data-start]");
  const where = (await trip.textContent("#inspect")) ?? "";
  await trip.fill("#inspect input", "Pack the passports");
  await trip.click('#inspect [data-inspect="note"]');
  const note = await trip.waitForSelector("h1[data-start] + .place >> text=Pack the passports", { timeout: 8000 }).then(() => true, () => false);
  const notes = await trip.evaluate(() => window.__host.command("user:list", { app: "demos/trip" }));
  for (const p of notes.filter((p) => p.id?.startsWith("note-"))) await trip.evaluate((id) => window.__host.command("user:remove", { app: "demos/trip", id }), p.id);
  check("inspect mode adds a note beside a part of the app's own page", /app's own page/.test(where) && note, JSON.stringify({ where: where.slice(0, 80), note }));
  await trip.close();
}
