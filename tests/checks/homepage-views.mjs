// The homepage's x-ray, story view and chapter 11 (site/home/x-ray.js,
// story-view.js, chapter-11-agent.js): x-ray outlines and names each
// plugin's view, story view lays the same chapters out as one column and is
// remembered, and chapter 11's recorded run ends in a real review card that
// puts the builder's plugin on the page.
//
// It runs in a browser context of its own, like the homepage's check.
export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext({ viewport: { width: 1280, height: 900 } });
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL);
  const seen = (selector, timeout = 8000) => page.waitForSelector(selector, { state: "attached", timeout }).then(() => true, () => false);

  // X-ray: off, nothing is outlined; on, a chapter's view is, with its plugin's id in its corner.
  const xray = '[data-plugin="x-ray"] button[data-action="x-ray"]';
  await page.waitForSelector(xray, { timeout: 10000 });
  await page.waitForSelector('[data-plugin="chapter-1-core"]', { timeout: 10000 });
  const look = () =>
    page.$eval('[data-plugin="chapter-1-core"]', (el) => ({ outline: getComputedStyle(el).outlineStyle, label: getComputedStyle(el, "::before").content }));
  const before = await look();
  await page.click(xray);
  const during = await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-plugin="chapter-1-core"]')).outlineStyle === "dashed", null, { timeout: 3000 }).then(look, () => look());
  check("x-ray outlines each plugin's view and names its plugin, only while it is on", before.outline === "none" && during.outline === "dashed" && during.label === '"chapter-1-core"', JSON.stringify({ before, during }));
  await page.click(xray);

  // Story view: one column, the chapters wider than the playground's column was, and kept after a reload.
  const columns = () => page.$eval(".home", (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  const guided = await columns();
  await page.click('[data-plugin="story-view"] button[data-value="story"]');
  const story = await page.waitForFunction(() => getComputedStyle(document.querySelector(".chapters ui-card")).borderTopStyle === "none", null, { timeout: 3000 }).then(() => true, () => false);
  check("story view lays the same chapters out as a story, without their cards", guided === 2 && story);
  await page.reload();
  const kept = await seen('[data-plugin="story-view"] button[data-value="story"][aria-pressed="true"]');
  check("story view is still chosen after a reload", kept);
  await page.click('[data-plugin="story-view"] button[data-value="guided"]');
  check("guided view puts the chapters back beside the playground", await page.waitForFunction(() => getComputedStyle(document.querySelector(".chapters ui-card")).borderTopStyle !== "none", null, { timeout: 3000 }).then(() => true, () => false));

  // Chapter 11: the agent's chat is on the page, and the recorded run ends in a real review card.
  check("chapter 11 draws, with the chat box to the builder below it", (await seen('[data-plugin="chapter-11-agent"]')) && (await seen('[data-plugin="chat"] option[value="builder"]')));
  await page.click('[data-plugin="chapter-11-agent"] button[data-action="replay"]');
  const review = '[data-key^="review:"]';
  const asked = await seen(`${review} >> text=reading-time`, 15000);
  check("the replay plays the builder's steps, then asks you to review the code it wrote", asked && (await page.locator('[data-plugin="chapter-11-agent"] .run li').count()) === 6);
  await page.click(`${review} >> button:text-is("Accept")`);
  const on = (await seen('[data-plugin="chapter-11-agent"] .outcome[data-tone="ok"]', 8000)) && (await seen('slot[name="playground"] [data-plugin="reading-time"]', 8000));
  check("accepting it puts Reading time on the page, as one of your own plugins", on && (await seen('slot[name="switchboard"] input[data-action="switch:reading-time"]', 5000)));
  await own.close();
}
