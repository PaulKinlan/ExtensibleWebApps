// Customize is on in every app, and easy to take off: an author's
// <meta name="customize" content="off"> leaves out its button (and inspect
// mode), and ?customize brings it back for a person who wants it anyway.

import { watchErrors } from "../page-errors.mjs";

export default async function ({ check, context, URL, errors }) {
  // The service worker is blocked so the page's own request can be rewritten to carry the meta.
  const own = await context.browser().newContext({ serviceWorkers: "block" });
  await own.route(`${URL}demos/habits/app.html*`, async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace("<head>", '<head>\n  <meta name="customize" content="off">');
    await route.fulfill({ response, body: html });
  });
  const page = await own.newPage();
  watchErrors(page, errors, "customize-off");
  const button = async (address) => {
    await page.goto(address);
    await page.waitForSelector('[data-key^="habits:"]', { state: "attached", timeout: 10000 }).catch(() => {});
    return !!(await page.waitForSelector("ui-panel .launch", { timeout: 3000 }).catch(() => null));
  };
  check("an app that says customize off has no Customize button", !(await button(`${URL}demos/habits/app.html`)));
  check("?customize brings the button back for the person", await button(`${URL}demos/habits/app.html?customize`));
  await own.close();

  // Every other app still has it.
  const plain = await context.newPage();
  await plain.goto(`${URL}demos/habits/app.html`);
  const shown = await plain.waitForSelector("ui-panel .launch", { timeout: 10000 }).then(() => true, () => false);
  check("an app that says nothing has the Customize button", shown);
  await plain.close();
}
