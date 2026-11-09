// The homepage's chapter 12 and its docs panel. Before a plugin of the
// visitor's own reaches its review card, the kernel runs plugins:beforeAdd,
// and Security check (site/home/security-check.js) stops one that reads
// notes and reaches the internet: no card, a reason, and the verdict listed.
// With the check switched off, the same save shows the card. The Docs
// switch opens the docs in a panel beside the page (docs/panel.js).
export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext({ viewport: { width: 1280, height: 900 } });
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL);
  const seen = (selector, timeout = 8000) => page.waitForSelector(selector, { state: "attached", timeout }).then(() => true, () => false);
  const chapter = '[data-plugin="chapter-12-security"]';
  const review = '[data-key^="review:"]';

  await page.waitForSelector(`${chapter} button[data-action="try"]`, { timeout: 15000 });
  await page.click(`${chapter} button[data-action="try"]`);
  const stopped = await seen(`${chapter} .outcome >> text=Stopped before review`, 8000);
  check("chapter 12: Security check stops a plugin that reads your notes and reaches the internet, before any review card", stopped && !(await page.$(review)), (await page.textContent(`${chapter} .outcome`).catch(() => "")) ?? "");
  check("chapter 12: and lists what it decided", await seen(`${chapter} .reviews li[data-blocked] >> text=Note backup`, 5000));

  // With the check switched off, the same save reaches the card, and the person decides.
  await page.click('slot[name="switchboard"] input[data-action="switch:security-check"]');
  await page.waitForTimeout(800);
  await page.click(`${chapter} button[data-action="try"]`);
  const card = await seen(`${review} >> text=Note backup`, 10000);
  check("chapter 12: with Security check off, the same plugin reaches its review card", card);
  if (card) await page.click(`${review} >> button:text-is("Decline")`);
  check("chapter 12: declining it saves nothing", await seen(`${chapter} .outcome >> text=Not saved`, 8000));
  await page.click('slot[name="switchboard"] input[data-action="switch:security-check"]');

  // The docs panel: the switch opens it beside the page, drawing a page of the docs.
  await page.click('[data-plugin="docs-panel"] button[data-action="docs"]');
  const open = await seen('slot[name="docs"] ui-markdown', 5000);
  const drawn = open && (await page.waitForFunction(() => (document.querySelector('slot[name="docs"] ui-markdown')?.shadowRoot?.textContent ?? document.querySelector('slot[name="docs"] ui-markdown')?.textContent ?? "").length > 200, null, { timeout: 8000 }).then(() => true, () => false));
  const docked = open && (await page.$eval(".docs-dock", (el) => getComputedStyle(el).position === "fixed"));
  check("the Docs switch opens the docs in a panel docked beside the page", drawn && docked);
  await page.selectOption('slot[name="docs"] select[data-action="page"]', "guide/agents.md");
  const agents = await page.waitForFunction(() => /agent/i.test(document.querySelector('slot[name="docs"] ui-markdown')?.shadowRoot?.textContent ?? document.querySelector('slot[name="docs"] ui-markdown')?.textContent ?? ""), null, { timeout: 8000 }).then(() => true, () => false);
  check("the docs panel opens another page from its list", agents && (await page.getAttribute('slot[name="docs"] ui-markdown', "src"))?.endsWith("/docs/guide/agents.md"));
  await page.click('slot[name="docs"] button[data-action="close"]');
  check("closing the panel takes it away", await page.waitForFunction(() => !document.querySelector('slot[name="docs"] [data-plugin]'), null, { timeout: 3000 }).then(() => true, () => false));
  await own.close();
}
