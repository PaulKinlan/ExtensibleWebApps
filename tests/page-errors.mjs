// Watches every page the tests open, in every browser context, for uncaught
// errors, and says where each came from: the check that opened the page, the
// page's address, and the first line of the stack. platform.test.mjs fails the
// run on any of them ("no uncaught errors in any page"), so an error that only
// comes now and then can be traced to its app the first time it is seen.
//
// A check names its page with watchErrors(page, errors, "what this page is");
// a page no check named is still watched, and reported by its address alone.

/** What each watched browser collects into, and the name a check gave each page. */
const lists = new WeakMap();
/** @type {WeakMap<import("playwright").Page, string>} */
const labels = new WeakMap();
/** @type {WeakSet<import("playwright").Page>} */
const watched = new WeakSet();

/** One line for an uncaught error: its message, who opened the page, the page, and where it was thrown. */
export function describeError(/** @type {string | undefined} */ label, /** @type {import("playwright").Page} */ page, /** @type {Error} */ e) {
  let where = "a page with no address";
  try {
    const url = new URL(page.url());
    where = `${url.pathname}${url.search}`;
  } catch {}
  // The first stack line that names a file: an error thrown with no stack (a rejected promise holding a string) has none.
  const frame = (e.stack ?? "").split("\n").map((line) => line.trim()).find((line) => /^at /.test(line));
  return `${e.message || String(e)} (${[label, `at ${where}`, frame].filter(Boolean).join(", ")})`;
}

function listen(/** @type {import("playwright").Page} */ page, /** @type {string[]} */ errors) {
  if (watched.has(page)) return;
  watched.add(page);
  page.on("pageerror", (e) => errors.push(describeError(labels.get(page), page, e)));
}

/**
 * Names `page` for the errors list, and watches it if nothing does yet (a page from a browser the runner doesn't watch).
 * @param {import("playwright").Page} page @param {string[]} errors @param {string} label
 */
export function watchErrors(page, errors, label) {
  labels.set(page, label);
  listen(page, errors);
}

/** Starts watching every page of `browser`'s contexts, made now or later; uncaught errors go into `errors`. @param {import("playwright").Browser} browser @param {string[]} errors */
export function watchAllPages(browser, errors) {
  lists.set(browser, errors);
  const watch = (/** @type {import("playwright").BrowserContext} */ context) => {
    for (const page of context.pages()) listen(page, errors);
    context.on("page", (page) => listen(page, errors));
  };
  for (const context of browser.contexts()) watch(context);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    watch(context);
    return context;
  };
}
