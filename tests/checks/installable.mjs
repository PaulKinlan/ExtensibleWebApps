// Installable apps, offline (sw/routes/manifest.js, src/host/install.ts, sw.js):
// every app links a manifest, one made from its page when its folder has none;
// an app's own manifest wins; an app made in the browser (/apps/<name>/) gets
// one too; and each opens with the network gone once it has been opened.
export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(`installable: ${e.message}`));

  /** Opens an address, and again once the service worker controls the page, so it has kept what the page loads. */
  const open = async (address, drawn) => {
    // On a first visit a folder's address is 404.html, which loads it again once the service worker starts:
    // a navigation of ours that meets that reload waits for it instead.
    const go = (to) => page.goto(to).catch((e) => (/interrupted by another navigation/.test(e.message) ? page.waitForLoadState("load") : Promise.reject(e)));
    await go(address);
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState("load");
    await go(address);
    return page.waitForSelector(drawn, { timeout: 10000 }).then(() => true, () => false);
  };
  /** The manifest the page links, as the browser would read it. */
  const manifest = () =>
    page
      .waitForFunction(() => document.querySelector('link[rel="manifest"]')?.href, null, { timeout: 5000 })
      .then((h) => h.jsonValue())
      .then((href) => page.evaluate((u) => fetch(u).then((r) => r.json().then((json) => ({ href: u, type: r.headers.get("Content-Type"), json }))), href))
      .catch((e) => ({ error: String(e) }));

  // The service worker starts from a page that is a file, so the folders below aren't answered by 404.html.
  await page.goto(`${URL}demos/habits/app.html`);
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("load");

  // An app with no manifest of its own: one made from its page.
  const habits = await open(`${URL}demos/habits/`, '[data-key="habits:habits"] ui-form');
  const made = await manifest();
  check(
    "an app with no manifest of its own links one made from its page: its title, description, folder and an icon",
    habits && made.json?.name === "Habits" && made.json.start_url === "/demos/habits/" && made.json.scope === "/demos/habits/" && made.json.display === "standalone" && /Tick off/.test(made.json.description) && made.json.icons?.[0]?.src === "/app-icon.svg" && /manifest\+json/.test(made.type),
    JSON.stringify(made).slice(0, 300),
  );
  const icon = await page.evaluate(() => fetch("/app-icon.svg").then((r) => r.ok && r.headers.get("Content-Type")));
  check("the platform's app icon is there for apps that name none", /svg/.test(String(icon)), String(icon));

  // Offline: the same app opens, and its plugin draws, with no network at all.
  await own.setOffline(true);
  await page.reload().catch(() => {});
  const offline = await page.waitForSelector('[data-key="habits:habits"] ui-form', { timeout: 10000 }).then(() => true, () => false);
  check("an app opened once opens again offline, its plugins drawing", offline);
  await own.setOffline(false);

  // An app's own manifest wins: the reading list's makes it a share target.
  await open(`${URL}demos/reading-list/`, '[data-key="library:books"] ui-table');
  const reading = await manifest();
  check("an app's own manifest.webmanifest is the one it links", reading.json?.name === "Reading list" && !!reading.json.share_target, JSON.stringify(reading).slice(0, 200));
  // In a space, the same manifest, served at the space's address so the app installs and opens files there.
  const spaced = await page.evaluate(() => fetch("/s/family/demos/reading-list/manifest.webmanifest").then((r) => r.json()).catch((e) => ({ error: String(e) })));
  check("in a space an app's own manifest is still the one served, with its file handlers and share target", spaced.name === "Reading list" && spaced.start_url === "./" && !!spaced.share_target && spaced.file_handlers?.[0]?.action === "open", JSON.stringify(spaced).slice(0, 200));

  // An app made in the browser: its files are in the data folder (std/maker/), and it installs and works offline too.
  await page.evaluate(async () => {
    let folder = await navigator.storage.getDirectory();
    for (const part of ["made", "apps", "tally"]) folder = await folder.getDirectoryHandle(part, { create: true });
    const write = async (name, text) => {
      const file = await (await folder.getFileHandle(name, { create: true })).createWritable();
      await file.write(text);
      await file.close();
    };
    await write(
      "app.html",
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Tally</title>
  <meta name="description" content="Counts things.">
  <meta name="theme-color" content="#225533">
  <meta name="short-name" content="Tallies">
  <link rel="stylesheet" href="/platform/host.css">
  <script type="module" src="/platform/host.js"></script>
  <link rel="plugin" href="tally.js">
</head>
<body><main><slot name="main"></slot></main></body>
</html>`,
    );
    await write("tally.js", `export const manifest = { id: "tally", name: "Tally", permissions: ["ui"] };\nexport default (ctx) => ctx.ui.render("main", "count", ctx.ui.html\`<p>Tally works</p>\`);\n`);
  });
  const tally = await open(`${URL}apps/tally/`, '[data-key="tally:count"] >> text=Tally works');
  const tallyManifest = await manifest();
  check(
    "an app made in the browser gets a manifest made from its page, with the short name its page gives",
    tally && tallyManifest.json?.name === "Tally" && tallyManifest.json.short_name === "Tallies" && tallyManifest.json.start_url === "/apps/tally/" && tallyManifest.json.theme_color === "#225533",
    JSON.stringify(tallyManifest).slice(0, 200),
  );
  await own.setOffline(true);
  await page.reload().catch(() => {});
  const tallyOffline = await page.waitForSelector('[data-key="tally:count"] >> text=Tally works', { timeout: 10000 }).then(() => true, () => false);
  check("an app made in the browser opens offline too", tallyOffline);
  await own.setOffline(false);
  await own.close();
}
