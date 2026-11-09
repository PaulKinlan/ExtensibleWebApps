// The debugger demo: it sees an app open in another tab, focuses on it, and
// shows that app's plugins (with their collections), its collection hooks as
// collection hooks, and its workers. Then the app's tab closes and leaves the list.
export default async function (page, { check, openTab, URL }) {
  const target = '[data-key^="debugger-target@"]';
  const habits = await openTab(`${URL}demos/habits/app.html`);
  const row = page.locator(`${target} li`, { hasText: "/demos/habits/" });
  const listed = await row.waitFor({ timeout: 8000 }).then(() => true, () => false);
  check("the debugger lists an app opened in another tab, with the folder it is in", listed);

  await row.locator("button", { hasText: "Focus" }).click();
  const plugins = '[data-key^="debugger-plugins@"]';
  const focused = await page
    .waitForFunction((sel) => {
      const names = [...document.querySelectorAll(`${sel} details.plugin > summary strong`)].map((s) => s.textContent.trim());
      // Customize is one of every app's plugins too (the host adds std/customize.js).
      return names.sort().join() === "Customize,Habits";
    }, plugins, { timeout: 8000 })
    .then(() => true, () => false);
  check("focused on an app, the debugger shows only that app's plugins", focused, await page.evaluate((sel) => [...document.querySelectorAll(`${sel} details.plugin > summary strong`)].map((s) => s.textContent.trim()).join(), plugins));

  await page.locator(`${plugins} details.plugin > summary`, { hasText: "Habits" }).click();
  const detail = await page.locator(`${plugins} details.plugin`, { hasText: "collection habits" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
  check("a plugin's entry shows what its manifest owns and asks for", detail && (await page.locator(`${plugins} details.plugin code`, { hasText: /^ui$/ }).count()) > 0);

  const hooks = '[data-key^="debugger-hooks@"]';
  const hook = page.locator(`${hooks} details.hook`, { hasText: "data:changed:habits" });
  const owned = await hook.waitFor({ timeout: 5000 }).then(async () => (await hook.locator("ui-badge", { hasText: "collection" }).count()) > 0, () => false);
  check("the hooks panel shows a collection's hooks, owned by its plugin", owned);

  const workers = await page.locator('[data-key^="debugger-workers@"] li', { hasText: "habits" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
  check("the workers panel shows the focused app's worker", workers);

  await habits.close({ runBeforeUnload: true });
  const gone = await row.waitFor({ state: "detached", timeout: 8000 }).then(() => true, () => false);
  check("a tab that closes leaves the debugger's list", gone);
}
