// Adding a plugin from the registry page (/packages/): "Add to an app" on a
// plugin's card lists the apps, each a link to the app that ends #add=<id>.
// The app's Customize answers the link by opening and asking to add that
// plugin, with the usual review of its code; nothing is added without it.
// Also here: what Customize says a package or one of the app's samples can do
// is the kernel's own wording (authoring.ts explain), and a sample says what
// it is and where it shows before it is added; and /demos/ links the registry.
export default async function ({ check, context, URL }) {
  const gallery = await fetch(`${URL}demos/`).then((r) => r.text(), () => "");
  check("/demos/ links the plugin registry in its header", /<nav class="site"[^>]*>[\s\S]*?<a href="\/packages\/">Plugins<\/a>[\s\S]*?<\/nav>/.test(gallery));

  const app = "demos/invoice";
  // A plain page first (no window.__host), which then becomes the app's page.
  const page = await context.newPage();
  const command = (name, arg) => page.evaluate(([name, arg]) => window.__host.command(name, arg), [name, { app, ...arg }]);
  const status = () => page.evaluate(() => document.querySelector("ui-panel [role=status]")?.textContent ?? "");
  try {
    await page.goto(`${URL}packages/`);
    await page.click("#world-clock button.add");
    const offered = await page.waitForSelector("#add-to:popover-open", { timeout: 5000 }).then(() => true, () => false);
    const heading = await page.textContent("#add-to h2");
    const href = await page.getAttribute('#add-to li[data-app="demos/invoice"] a', "href");
    check('"Add to an app" on a registry card lists the apps to add it to', offered && /World clock/.test(heading ?? "") && (href ?? "").endsWith("/demos/invoice/app.html#add=world-clock"), `${heading}: ${href}`);
    // An app that links the plugin already isn't offered for it.
    await page.click('#add-to [popovertargetaction="hide"]');
    const left = await page.evaluate(() => {
      const button = [...document.querySelectorAll("button.add")].find((b) => b.dataset.in.split(" ").some((path) => path.startsWith("demos/")));
      if (!button) return null;
      button.click();
      const has = button.dataset.in.split(" ").filter((path) => path.startsWith("demos/"));
      return { id: button.dataset.add, has, shown: has.filter((path) => !document.querySelector(`#add-to li[data-app="${path}"]`)?.hidden) };
    });
    check("the apps that already link a plugin aren't offered for it", !!left && left.has.length > 0 && !left.shown.length, JSON.stringify(left));
    await page.click('#add-to [popovertargetaction="hide"]');

    await page.click("#world-clock button.add");
    await page.click('#add-to li[data-app="demos/invoice"] a');
    await page.waitForFunction(() => window.__host, null, { timeout: 15000 });
    // World clock needs the clock service, so Clock is asked for first: one review each, as from the panel.
    const asked = [];
    for (const name of ["adds Clock", "adds World clock"]) {
      asked.push(await page.waitForSelector(`[data-key^="review:"] >> text=${name}`, { timeout: 15000 }).then(() => true, () => false));
      await page.click('[data-key^="review:"] button:has-text("Accept")', { timeout: 5000 }).catch(() => {});
    }
    check("a link to an app ending #add=<id> opens Customize with that plugin's review", asked.every(Boolean), JSON.stringify(asked));
    const said = await page.waitForFunction(() => /^Added /.test(document.querySelector("ui-panel [role=status]")?.textContent ?? ""), null, { timeout: 20000 }).then(status, () => status());
    const drew = await page.waitForFunction(() => /\d\d:\d\d/.test(document.querySelector(".world-clock strong")?.textContent ?? ""), null, { timeout: 10000 }).then(() => true, () => false);
    check("accepting it adds the plugin and what it needs, turned on, and it draws", /Clock and World clock/.test(said) && drew, said);
    check("the address no longer asks, so loading the page again adds nothing", !(await page.evaluate(() => location.hash)));

    // Asked for again, it says where things stand rather than asking twice.
    // (The same page with only its # changed isn't loaded again, so load it.)
    await page.goto(`${URL}${app}/app.html#add=world-clock`);
    await page.reload();
    await page.waitForFunction(() => window.__host);
    const again = await page.waitForFunction(() => /already added/.test(document.querySelector("ui-panel [role=status]")?.textContent ?? ""), null, { timeout: 15000 }).then(status, () => status());
    const reviews = await page.locator('[data-key^="review:"]').count();
    check("asking for a plugin that is already added says so, with no review", /World clock is already added here, and on/.test(again) && reviews === 0, `${again} (${reviews} reviews)`);
  } finally {
    for (const id of ["world-clock", "clock"]) await command("user:remove", { id }).catch(() => {});
    await page.close({ runBeforeUnload: true });
  }

  // Only the registry's own plugins can be asked for by a link.
  const other = await context.newPage();
  try {
    await other.goto(`${URL}demos/trip/app.html#add=not-a-plugin`);
    await other.waitForFunction(() => window.__host);
    const text = await other
      .waitForFunction(() => /no plugin called/.test(document.querySelector("ui-panel [role=status]")?.textContent ?? ""), null, { timeout: 15000 })
      .then(() => other.evaluate(() => document.querySelector("ui-panel [role=status]").textContent), () => "");
    const none = await other.locator('[data-key^="review:"]').count();
    check("a link that asks for something the registry doesn't list adds nothing, and says so", /no plugin called “not-a-plugin”/.test(text) && none === 0, text);

    // The panel is open on Plugins: each package and each of the app's samples says what it can do, in the kernel's words.
    const words = await other.evaluate(() => [...document.querySelectorAll('[data-kind="ui"] .entry.package')].find((e) => e.querySelector('[data-package="world-clock"]'))?.querySelector("details.can .asks")?.textContent ?? "");
    check("Customize says what a package can do in the kernel's own words", /Draw on this page\./.test(words) && /Use the clock service\./.test(words), words);
    const sample = await other.evaluate(() => {
      const entry = [...document.querySelectorAll(".entry.sample")].find((e) => e.querySelector('[data-sample$="/samples/countdown.js"]'));
      return entry ? { text: entry.querySelector(".entry-main").textContent.replace(/\s+/g, " ").trim(), can: entry.querySelector("details.can .asks")?.textContent ?? "" } : null;
    });
    check("a sample says what it is, where it shows and what it can do before it is added", !!sample && /Shows /.test(sample.text) && /Draw on this page\./.test(sample.can) && sample.text.length > 40, JSON.stringify(sample));
  } finally {
    await other.close({ runBeforeUnload: true });
  }
}
