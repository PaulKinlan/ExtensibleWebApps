// The homepage's chapters 7 to 9, each doing what it explains: the gate
// refusing a plugin that asks for more than its manifest, a write to notes
// the plugin doesn't own waiting for a review card (and the schema refusing
// one first), and HTML drawn as written keeping only what the allowlist does.
// Also: links from the homepage to other pages load them.
//
// It runs in a browser context of its own, like the homepage's check.
import { watchErrors } from "../page-errors.mjs";

export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  watchErrors(page, errors, "chapters");
  await page.goto(URL);
  const seen = (selector, timeout = 8000) => page.waitForSelector(selector, { state: "attached", timeout }).then(() => true, () => false);

  // 7: the gate refuses this chapter, which asks only for ui.
  const seven = 'slot[name="permissions"]';
  await page.waitForSelector(`${seven} button[data-action="read"]`, { timeout: 8000 });
  await page.click(`${seven} button[data-action="read"]`);
  check("chapter 7: the gate refuses reading notes without data:read:learning", await seen(`${seven} .refused`, 5000));
  await page.click(`${seven} button[data-action="switch"]`);
  check("chapter 7: and refuses switching a plugin off without plugins:manage", await seen(`${seven} .answer >> text=plugins:manage`, 5000));

  // 8: the schema refuses a note that isn't text, before any review; a good note waits for one.
  const eight = 'slot[name="data"]';
  const notes = 'slot[name="playground"]';
  const review = '[data-key^="review:"]';
  await page.click(`${eight} button[data-action="invalid"]`);
  check("chapter 8: the schema refuses a note that isn't text, without a review", (await seen(`${eight} .answer >> text=schema refused`, 5000)) && !(await page.$(review)));
  await page.click(`${eight} button[data-action="add"]`);
  check("chapter 8: adding a note to notes it doesn't own shows a review card", await seen(`${review} >> text=Chapter 8`, 5000));
  await page.click(`${review} >> text=Decline`);
  check("chapter 8: declining writes nothing", await seen(`${eight} .answer >> text=wasn't written`, 5000));
  await page.click(`${eight} button[data-action="add"]`);
  await seen(review, 5000);
  await page.click(`${review} >> button:text-is("Accept")`);
  check("chapter 8: accepting writes the note", (await seen(`${eight} .answer >> text=You accepted it`, 5000)) && (await seen(`${notes} >> text=Chapter 8 added this note`, 5000)));

  // 9: the example's script, handler, style, javascript: link and remote image are dropped; the rest is drawn.
  const nine = 'slot[name="views"]';
  const drawn = `${nine} ui-card.drawn`;
  await seen(`${drawn} h3`);
  const kept = await page.$eval(drawn, (card) => ({
    heading: !!card.querySelector("h3"),
    badge: !!card.querySelector("ui-badge"),
    script: !!card.querySelector("script"),
    handler: !!card.querySelector("[onclick]"),
    style: !!card.querySelector("[style]"),
    jsLink: [...card.querySelectorAll("a")].some((a) => /^javascript:/i.test(a.getAttribute("href") ?? "")),
    remoteImage: !!card.querySelector('img[src^="https:"]'),
  }));
  check("chapter 9: HTML drawn as written keeps the allowlist, and drops scripts, handlers, styles, javascript: links and remote images", kept.heading && kept.badge && !kept.script && !kept.handler && !kept.style && !kept.jsLink && !kept.remoteImage, JSON.stringify(kept));
  await page.fill(`${nine} textarea[name="html"]`, "<p><strong>Mine</strong></p>");
  await page.click(`${nine} button[type="submit"]`);
  check("chapter 9: drawing your own HTML replaces it", await seen(`${drawn} strong >> text=Mine`, 5000));

  // A link from the homepage to another page loads that page, rather than becoming a screen of the homepage.
  await page.click('header a[href="/docs/"]');
  const docs = await page.waitForFunction(() => !!document.querySelector(".docs") && location.pathname === "/docs/", null, { timeout: 10000 }).then(() => true, () => false);
  check("the homepage's link to the docs opens the docs", docs, page.url());
  await own.close();
}
