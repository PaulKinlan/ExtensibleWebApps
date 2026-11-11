// A plugin that waits for its first use (its manifest's `standIn`, src/kernel/remote.ts).
//
// Customize is on every app, and most visits never open it. Its manifest names the view that holds its place,
// the button; the kernel draws that, and starts the plugin the first time the person does something there. So
// an app pays for the button alone: no worker for Customize, and none of its panel's files, until it is opened.
// It is one of the app's plugins all the same: listed, and turned off and on like the others.
import { watchErrors } from "../page-errors.mjs";

export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  watchErrors(page, errors, "stand-in");
  const BUTTON = 'slot[name="customize"] ui-panel .launch';
  const workers = () => page.evaluate(() => [...window.__host.workers.keys()].map((key) => key.split("@")[0]).sort().join());
  const fetched = () => page.evaluate(() => performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname).filter((p) => /customize\.html|ui-code/.test(p)).join());
  const open = () => page.evaluate(() => document.querySelector('slot[name="customize"] ui-panel')?.shadowRoot?.querySelector("#panel")?.matches(":popover-open") === true);
  try {
    await page.goto(`${URL}demos/habits/app.html`);
    await page.waitForSelector('[data-key="habits:habits"] ui-form', { timeout: 15000 });
    const button = await page.waitForSelector(BUTTON, { timeout: 8000 }).then(() => true, () => false);
    // Long enough for a worker the kernel had started to be there.
    await page.waitForTimeout(1500);
    const before = { workers: await workers(), fetched: await fetched() };
    check("an app has the Customize button without starting Customize: no worker for it, and none of its panel's files", button && before.workers === "habits" && before.fetched === "", JSON.stringify(before));

    // It is one of the app's plugins before it has started: another plugin's plugins.app() lists it.
    const installed = await page.evaluate(() =>
      window.__host.command("install", `export const manifest = { id: 'stand-in-probe', name: 'Probe', permissions: ['plugins:read'], scope: 'tab' };
export default async (ctx) => { ctx.log('stand-in-probe ' + (await ctx.call('plugins', 'app')).map((p) => p.id + (p.enabled ? '' : ' off')).join()); };`),
    );
    const listed = await page.waitForFunction(() => window.__host.traces.findLast((e) => e.detail?.startsWith("stand-in-probe "))?.detail, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => "");
    check("before it has started, Customize is still listed among the app's plugins", /\bcustomize\b(?! off)/.test(listed), listed || JSON.stringify(installed));
    await page.evaluate(() => window.__host.command("uninstall", "stand-in-probe")).catch(() => {});

    // The first press opens the panel at once, starts Customize, and Customize hears the press: it draws the open panel.
    await page.click(BUTTON);
    const openedAtOnce = await open();
    const drawn = await page.waitForSelector('slot[name="customize"] .customize .tabs', { timeout: 10000 }).then(() => true, () => false);
    check("pressing the button opens the panel, starts Customize, and its panel draws in the one that opened", openedAtOnce && drawn && (await open()) && (await workers()) === "customize,habits", `open at once ${openedAtOnce}, drawn ${drawn}, workers ${await workers()}`);
  } finally {
    await own.close();
  }
}
