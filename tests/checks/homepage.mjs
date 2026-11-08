// The homepage (index.html at /): an app made of plugins that explains the
// platform. Its plugins draw, the switchboard and the chapters switch them,
// a hook stops a note, turning everything off leaves the bare page, and
// ?reset brings it all back.
//
// It runs in a browser context of its own, so a kernel and data folder of
// its own: switching plugins here, and the trace it makes, don't reach the
// workbench's checks.
export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL);
  const key = (id) => `slot :is([data-key^="${id}:"], [data-key^="${id}@"])`;
  const ids = ["learning-notes", "note-stats", "chapter-1-core", "chapter-2-plugins", "chapter-3-hooks", "switchboard"];
  const drawn = await Promise.all(ids.map((id) => page.waitForSelector(key(id), { state: "attached", timeout: 8000 }).then(() => true, () => false)));
  check("the homepage draws its notes, stats, chapters and switchboard", drawn.every(Boolean), ids.filter((_, i) => !drawn[i]).join(", "));
  // As many switches as the page links plugins, so adding one to the homepage doesn't change this check.
  const listsAll = (p) =>
    p.waitForFunction(() => document.querySelectorAll('slot[name="switchboard"] input[data-action^="switch:"]').length === document.querySelectorAll('link[rel~="plugin"]').length, null, { timeout: 8000 }).then(() => true, () => false);
  check("the switchboard lists every plugin the homepage links", await listsAll(page));

  // A note is saved, and Quiet please stops one written in capitals.
  const notes = 'slot[name="playground"]';
  await page.fill(`${notes} textarea[name="text"]`, "Turning things off is safe");
  await page.click(`${notes} button[type="submit"]`);
  await page.waitForSelector(`${notes} >> text=Turning things off is safe`, { timeout: 5000 });
  const counted = await page.waitForSelector(`${notes} ui-stat[label="Notes"][value="1"]`, { timeout: 5000 }).then(() => true, () => false);
  check("a learning note is saved, and Note stats counts it", counted);
  await page.fill(`${notes} textarea[name="text"]`, "THIS IS VERY LOUD");
  await page.click(`${notes} button[type="submit"]`);
  const blocked = await page.waitForSelector(`${notes} >> text=Quiet please is on`, { timeout: 5000 }).then(() => true, () => false);
  check("Quiet please stops a note in capitals through data:beforeWrite:learning", blocked);

  await page.fill(`${notes} textarea[name="text"]`, "今天学习了插件");
  await page.click(`${notes} button[type="submit"]`);
  const uncased = await page.waitForSelector(`${notes} >> text=今天学习了插件`, { timeout: 5000 }).then(() => true, () => false);
  check("Quiet please lets through notes in scripts without capitals", uncased);

  // A second tab: its tab-scoped plugins start before its app has opened, and catch up when it has.
  const second = await own.newPage();
  await second.goto(URL);
  const listed = await listsAll(second);
  const ticked = await second.waitForFunction(() => document.querySelector('[data-plugin="chapter-2-plugins"] input[data-action="toggle"]')?.checked, null, { timeout: 5000 }).then(() => true, () => false);
  check("a second homepage tab lists the plugins and shows the chapters' switches as on", listed && ticked);
  await second.close({ runBeforeUnload: true });

  // Chapter 2's switch turns Note stats off, and the switchboard hears it.
  await page.click('[data-plugin="chapter-2-plugins"] input[data-action="toggle"]');
  await page.waitForSelector(key("note-stats"), { state: "detached", timeout: 5000 }).catch(() => {});
  const unticked = await page.waitForFunction(() => !document.querySelector('slot[name="switchboard"] input[data-action="switch:note-stats"]')?.checked, null, { timeout: 5000 }).then(() => true, () => false);
  check("a chapter's switch turns a plugin off, and the switchboard shows it", unticked);
  const offered = await page.waitForSelector(`${key("reset")} >> text=Note stats`, { timeout: 5000 }).then(() => true, () => false);
  if (offered) await page.click(`${key("reset")} button[data-action="reset"]`);
  const back = await page.waitForSelector(key("note-stats"), { state: "attached", timeout: 5000 }).then(() => true, () => false);
  check("Reset offers itself when a plugin is off, and turns it back on", offered && back);

  // Turning every plugin off leaves the page as the kernel leaves it; ?reset brings them back.
  await page.click('[data-plugin="chapter-1-core"] button[data-action="all-off"]');
  const bare = await page.waitForFunction(() => !document.querySelector("slot [data-key]"), null, { timeout: 8000 }).then(() => true, () => false);
  check("chapter 1 turns every plugin off, leaving the page's own fallbacks", bare && (await page.isVisible('slot[name="chapters"] >> text=Turn everything back on')));
  await page.goto(`${URL}?reset`);
  const restored = await Promise.all(ids.map((id) => page.waitForSelector(key(id), { state: "attached", timeout: 8000 }).then(() => true, () => false)));
  check("?reset turns the page's plugins back on, and leaves the address clean", restored.every(Boolean) && !page.url().includes("reset"), page.url());
  check("learning notes are still there after everything was off", await page.isVisible(`${notes} >> text=Turning things off is safe`));
  await own.close();
}
