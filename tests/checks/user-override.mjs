// A person's plugin with the id of one the app links replaces it in that
// app (src/kernel/kernel.ts, openApp): the app's copy stops and theirs runs
// under the same id, so it keeps the data and the places that id has.
// Turning theirs off brings the app's back. In Customize, a copy of the
// app's plugin saved under its id is reviewed as replacing it.

export default async function ({ check, openTab, URL }) {
  const app = "demos/habits";
  const page = await openTab(`${URL}${app}/app.html`);
  const command = (name, arg) => page.evaluate(([name, arg]) => window.__host.command(name, arg), [name, { app, ...arg }]);
  const theirs = 'export const manifest = { id: "habits", name: "My habits", permissions: ["ui"] };\nexport default (ctx) => ctx.ui.render("main", "mine", ctx.ui.html`<p>My own habits</p>`);\n';
  const drawn = (selector) => page.waitForSelector(selector, { timeout: 10000 }).then(() => true, () => false);
  const gone = (selector) => page.waitForSelector(selector, { state: "detached", timeout: 10000 }).then(() => true, () => false);
  const appView = '[data-key="habits:habits"]';
  const theirView = '[data-key="habits:mine"] >> text=My own habits';
  try {
    await drawn(appView);
    const added = await command("user:add", { files: [{ name: "habits.js", data: theirs }] });
    const stillApps = await drawn(appView);
    check("a person's plugin with the id of the app's own is added off, and the app's copy keeps running", added?.ok !== false && stillApps, JSON.stringify(added));

    await command("user:on", { id: "habits" });
    const replaced = (await drawn(theirView)) && (await gone(appView));
    const refused = await page.evaluate(() => window.__host.traces.filter((e) => /already running/.test(e.detail ?? "")).map((e) => e.detail));
    check("turning it on replaces the app's plugin with theirs, under the same id, with no clash", replaced && !refused.length, refused.join("; "));

    await command("user:off", { id: "habits" });
    const back = (await drawn(appView)) && (await gone(theirView));
    check("turning theirs off brings the app's own plugin back", back);
  } finally {
    await command("user:remove", { id: "habits" }).catch(() => {});
    await page.close();
  }
}
