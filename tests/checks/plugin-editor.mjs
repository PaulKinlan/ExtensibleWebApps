// The plugin editor on the homepage (std/plugin-editor.js): a person starts
// from a template, sees what it asks for, saves it after a review, and it
// runs and shows up on the switchboard; a copy of a page's plugin gets an id
// of its own; and removing it, after a review, takes it off the page.
//
// It runs in a browser context of its own, like the homepage's check, so the
// plugins it saves stay out of the other checks.
export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL);
  const editor = 'slot[name="editor"]';
  const review = '[data-key^="review:"]';
  const key = (id) => `slot :is([data-key^="${id}:"], [data-key^="${id}@"])`;
  const seen = (selector, timeout = 6000) => page.waitForSelector(selector, { state: "attached", timeout }).then(() => true, () => false);
  const code = () => page.$eval(`${editor} ui-code`, (e) => e.value);
  /** Picks a starting point once the picker offers it. */
  const start = async (value) => {
    await page.waitForSelector(`${editor} select option[value="${value}"]`, { state: "attached", timeout: 8000 });
    await page.selectOption(`${editor} select`, value);
  };

  await start("template:card.js");
  const asks = await seen(`${editor} >> text=My card asks to`);
  check("the editor loads a template and says what it asks for, before it runs", asks && (await page.isVisible(`${editor} >> text=Draw on this page.`)) && !(await page.$(key("my-card"))));

  await page.click(`${editor} button:has-text("Save and run")`);
  const reviewed = await seen(`${review} >> text=adds My card`);
  check("saving shows a review with the plugin's code and permissions first", reviewed && (await page.isVisible(`${review} >> text=Draw on this page.`)));
  // The card is in a dialog that stays in view, and the editor waits for it rather than asking twice.
  const inView = await page.evaluate(() => {
    const dialog = document.querySelector("dialog#review");
    const box = dialog?.getBoundingClientRect();
    return !!dialog?.open && !!box && box.top >= 0 && box.bottom <= innerHeight;
  });
  const waits = await page.isDisabled(`${editor} button:has-text("Save and run")`);
  check("the review opens in a dialog in view, and the editor's buttons wait for the answer", inView && waits && (await page.$$(review)).length === 1);
  await page.click(`${review} >> text=Accept`);
  const runs = await seen(`${key("my-card")} >> text=This card is a plugin you wrote`, 8000);
  const listed = await seen('slot[name="switchboard"] input[data-action="switch:my-card"]');
  check("once accepted, the plugin runs on the page and the switchboard lists it", runs && listed);
  const traced = await seen(`${editor} .trace >> text=Hello from my card`);
  check("the editor shows what the plugin did, from the trace", traced);

  // A copy of one of the page's plugins gets an id of its own, so it can run beside the original.
  await start("plugin:note-stats");
  await seen(`${editor} >> text=Note stats (copy) asks to`);
  check("a copy of a page's plugin gets an id and name of its own", /id: "note-stats-copy"/.test(await code()) && /name: "Note stats \(copy\)"/.test(await code()));

  // A person's own plugin can be opened again, and removed.
  await start("own:my-card");
  await page.waitForSelector(`${editor} button[data-action="remove"]`, { timeout: 5000 });
  await page.click(`${editor} button[data-action="remove"]`);
  await page.waitForSelector(`${review} >> text=removes My card`, { timeout: 5000 });
  await page.click(`${review} >> text=Accept`);
  const gone = await page.waitForSelector(key("my-card"), { state: "detached", timeout: 8000 }).then(() => true, () => false);
  check("removing your plugin, after a review, takes it off the page", gone && /My card/.test(await code()));
  await own.close();
}
