// Look inside, on the homepage (std/view-source.js and std/hook-tracer.js):
// view source shows a plugin's code and what it may do, and the hook tracer
// shows the hooks a note runs, in order, with what each plugin said.
//
// It runs in a browser context of its own, like the homepage's check, so its
// notes and trace stay out of the other checks.
export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL);
  const inspect = 'slot[name="inspect"]';
  const source = '[data-key^="view-source@"]';
  const tracer = '[data-key^="hook-tracer@"]';
  const seen = (selector, timeout = 8000) => page.waitForSelector(selector, { state: "attached", timeout }).then(() => true, () => false);

  // View source: pick Quiet please, and see its code and its permissions in words.
  await page.waitForSelector(`${inspect} ${source} button[data-action="show:quiet-please"]`, { timeout: 8000 });
  await page.click(`${inspect} ${source} button[data-action="show:quiet-please"]`);
  const code = await page
    .waitForFunction((s) => /data:beforeWrite:learning/.test(document.querySelector(`${s} ui-code`)?.value ?? ""), `${inspect} ${source}`, { timeout: 5000 })
    .then(() => true, () => false);
  const may = await seen(`${inspect} ${source} .may >> text=hook:intercept:data:beforeWrite:learning`, 3000);
  check("view source shows a plugin's code and what its permissions let it do", code && may);
  check("view source's code box can't be edited", await page.$eval(`${inspect} ${source} ui-code`, (e) => e.hasAttribute("readonly")));
  await page.click(`${inspect} ${source} button[data-action="hide"]`);
  check("view source closes", await page.waitForSelector(`${inspect} ${source} ui-code`, { state: "detached", timeout: 3000 }).then(() => true, () => false));

  // The hook tracer: a note runs data:beforeWrite (Quiet please answers) and then data:changed (Note stats hears it).
  const notes = 'slot[name="playground"]';
  await seen(`${inspect} ${tracer}`);
  await page.fill(`${notes} textarea[name="text"]`, "Hooks run in order");
  await page.click(`${notes} button[type="submit"]`);
  const asked = await seen(`${inspect} ${tracer} .steps >> text=Quiet please let it through`);
  const heard = await seen(`${inspect} ${tracer} .steps >> text=/Heard by .*Note stats/`);
  check("the hook tracer shows a note's hooks and what each plugin said", asked && heard, `asked ${asked}, heard ${heard}`);
  const order = await page.$eval(`${inspect} ${tracer} .action`, (e) => [...e.querySelectorAll(".steps code")].map((c) => c.textContent));
  check("the hook tracer lists the hooks in the order they ran", order.indexOf("data:beforeWrite:learning") === 0 && order.includes("data:changed:learning"), order.join(", "));
  check("the hook tracer says who started it", await seen(`${inspect} ${tracer} .action >> text=Learning notes called`, 2000));

  await page.fill(`${notes} textarea[name="text"]`, "STOP SHOUTING");
  await page.click(`${notes} button[type="submit"]`);
  check("the hook tracer shows a plugin stopping a write", await seen(`${inspect} ${tracer} .stopped >> text=Quiet please stopped it`));

  // A switch belongs to the action that asked for it, so the tracer names who switched.
  const toggle = 'slot[name="switchboard"] input[data-action="switch:note-stats"]';
  await page.click(toggle);
  check("the hook tracer says which plugin switched another off", await seen(`${inspect} ${tracer} .action >> text=Switchboard called plugins.setEnabled`));
  await page.click(toggle);

  await page.click(`${inspect} ${tracer} button[data-action="clear"]`);
  check("Clear empties the hook tracer", await page.waitForSelector(`${inspect} ${tracer} .action`, { state: "detached", timeout: 3000 }).then(() => true, () => false));
  await own.close();
}
