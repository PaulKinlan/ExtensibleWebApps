// Getting around the site: /demos/ lists every demo app, and every demo's
// header links Home, All demos, Docs and the Workbench, so no page is a dead end.
import { readdirSync, existsSync, readFileSync } from "node:fs";

export default async function ({ check, context, URL, errors }) {
  const root = new globalThis.URL("../../demos/", import.meta.url);
  const apps = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(new globalThis.URL(`${e.name}/app.html`, root))).map((e) => e.name);
  // The page as the site serves it: the build fills its lists from the apps (scripts/generated.mjs).
  const gallery = await fetch(`${URL}demos/`).then((r) => r.text(), () => "");
  const unlisted = apps.filter((name) => !gallery.includes(`href="/demos/${name}/app.html"`));
  check("/demos/ lists every demo app", !unlisted.length, unlisted.join(", "));
  const noNav = apps.filter((name) => {
    const html = readFileSync(new globalThis.URL(`${name}/app.html`, root), "utf8");
    return !["/", "/demos/", "/docs/", "/workbench/"].every((href) => html.includes(`<a href="${href}">`));
  });
  check("every demo's header links Home, All demos, Docs and the Workbench", !noNav.length, noNav.join(", "));

  const own = await context.browser().newContext();
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${URL}demos/habits/app.html`);
  await page.click('header nav.site a[href="/demos/"]');
  const atGallery = await page.waitForFunction(() => location.pathname === "/demos/" && document.title.startsWith("Demo apps"), null, { timeout: 8000 }).then(() => true, () => false);
  check("All demos, from a demo, opens the list of demos", atGallery, page.url());
  await page.click('a[href="/demos/reading-list/app.html"]');
  const opened = await page.waitForFunction(() => document.title === "Reading list", null, { timeout: 8000 }).then(() => true, () => false);
  check("a demo opens from the list", opened, page.url());
  await own.close();
}
