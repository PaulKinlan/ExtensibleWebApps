// An app's page is also its folder's page: /demos/habits/ is /demos/habits/app.html, as a file, so a first
// visit to the address people share is answered with the app and not with 404.html (vite.config.ts says why).
// The one rule for which folders get one, shared by everything that lays out a site: the platform's build
// (vite.config.ts), a project of your own (scripts/extensible-app.mjs) and one app's Worker (scripts/deploy-app.mjs).

/** The folder page's name, and the app's page it is a copy of. */
export const FOLDER_PAGE = { name: "index.html", from: "app.html" };

/**
 * The folder pages to write for a site, given the address of every page it has (`demos/habits/app.html`,
 * no leading slash): `{ "demos/habits/index.html": "demos/habits/app.html" }`. A folder with an index.html
 * of its own keeps it.
 * @param {Iterable<string>} pages @returns {Record<string, string>}
 */
export function folderPages(pages) {
  const all = new Set(pages);
  /** @type {Record<string, string>} */
  const out = {};
  for (const page of all) {
    if (page !== FOLDER_PAGE.from && !page.endsWith(`/${FOLDER_PAGE.from}`)) continue;
    const index = `${page.slice(0, -FOLDER_PAGE.from.length)}${FOLDER_PAGE.name}`;
    if (!all.has(index)) out[index] = page;
  }
  return out;
}
