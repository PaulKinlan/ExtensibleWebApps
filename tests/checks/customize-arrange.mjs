// Customize, redone: the person moves a plugin's view to another spot on the
// page in arrange mode (src/host/arrange.ts), the move is kept for them and
// app (src/kernel/moves.ts) across a reload, and Put back undoes it. The
// picker lists services apart from what shows on the page, and says a plugin
// it just added is off with a button to turn it on. Make a plugin starts
// from a starter, puts it where the person points, and saves it after a
// review. Layout lists the page's parts and the ui-* elements.
export default async function ({ check, openTab, URL }) {
  const page = await openTab(`${URL}demos/trip/app.html`);
  const app = await page.evaluate(() => window.__host.app);
  const clock = '.place[data-place^="world-clock/"]';
  const review = '[data-key^="review:"]';
  try {
    await page.waitForSelector("ui-panel .launch", { timeout: 8000 });
    await page.click("ui-panel .launch");
    await page.waitForSelector('[data-kind="service"] [data-package="clock"]', { timeout: 10000 });
    check("the picker lists services in a section of their own", !(await page.$('[data-kind="ui"] [data-package="clock"]')));

    await page.click('[data-package="world-clock"]');
    for (const name of ["Clock", "World clock"]) {
      await page.waitForSelector(`${review} >> text=${name}`, { timeout: 15000 }).catch(() => {});
      await page.click(`${review} >> text=Accept`, { timeout: 5000 }).catch(() => {});
    }
    const follow = await page.waitForSelector('[data-follow][data-value="world-clock"]', { timeout: 10000 }).then(() => true, () => false);
    check("after adding a plugin, the picker says it is off and offers to turn it on", follow);
    await page.click("[data-follow]");
    await page.waitForSelector(`${clock} [data-plugin]`, { timeout: 10000 });

    // Move it above the trip's heading, in arrange mode.
    await page.click('[data-move^="world-clock/"]');
    await page.waitForSelector("#arrange:not([hidden])", { timeout: 5000 });
    await page.click("h1[data-start]");
    await page.click('#arrange [data-put="before"]');
    const moved = () => page.evaluate((clock) => document.querySelector(clock)?.nextElementSibling?.matches("h1[data-start]") ?? false, clock);
    await page.waitForFunction((clock) => document.querySelector(clock)?.nextElementSibling?.matches("h1[data-start]"), clock, { timeout: 8000 }).catch(() => {});
    check("arrange mode moves a plugin's view to where the person points", await moved());
    await page.click("#arrange [data-arrange-done]").catch(() => {});

    await page.reload();
    await page.waitForSelector(`${clock} [data-plugin]`, { timeout: 10000 });
    check("a move is kept for the person and app across a reload", await moved());

    await page.click("ui-panel .launch");
    await page.click('[data-unmove^="world-clock/"]', { timeout: 8000 });
    await page.waitForFunction((clock) => !document.querySelector(clock)?.nextElementSibling?.matches("h1[data-start]"), clock, { timeout: 8000 }).catch(() => {});
    check("Put back returns a moved view to where its plugin puts it", !(await moved()));

    // Layout: the page's parts and the elements.
    await page.click('[data-tab="layout"]');
    const parts = await page.waitForSelector('.layout dt >> text="#day-1"', { timeout: 8000 }).then(() => true, () => false);
    const elements = !!(await page.$(".layout summary >> text=<ui-card>"));
    check("Layout lists the parts of the page a plugin can go beside, and the ui-* elements", parts && elements, JSON.stringify({ parts, elements }));

    // Make a plugin: a note, above the heading.
    await page.click('[data-tab="make"]');
    await page.click('[data-starter="note.js"]');
    await page.waitForSelector("[data-make-save]", { timeout: 8000 });
    await page.click("[data-spot]");
    await page.waitForSelector("#arrange:not([hidden])", { timeout: 5000 });
    await page.click("h1[data-start]");
    await page.click('#arrange [data-put="before"]');
    await page.waitForSelector("ui-panel [data-make-save]", { state: "visible", timeout: 5000 }).catch(() => {});
    await page.fill("[data-make-name]", "Packing note");
    await page.click("[data-make-save]");
    const reviewed = await page.waitForSelector(`${review} >> text=Packing note`, { timeout: 10000 }).then(() => true, () => false);
    if (reviewed) await page.click(`${review} >> text=Accept`);
    const made = await page.waitForFunction(() => document.querySelector("h1[data-start]")?.previousElementSibling?.matches('.place[data-place^="packing-note/"]') && document.querySelector('[data-place^="packing-note/"]')?.textContent.includes("Remember"), null, { timeout: 10000 }).then(() => true, () => false);
    check("Make a plugin saves a starter, after a review, where the person pointed", reviewed && made, JSON.stringify({ reviewed, made }));
  } finally {
    for (const id of ["packing-note", "world-clock", "clock"]) await page.evaluate(([app, id]) => window.__host.command("user:remove", { app, id }), [app, id]).catch(() => {});
    await page.evaluate((app) => window.__host.command("place:move", { app, plugin: "world-clock", place: "strip", to: null }), app).catch(() => {});
    await page.close({ runBeforeUnload: true });
  }
}
