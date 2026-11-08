// Themes (src/shared/theme.ts): a plugin with ui:theme sets design tokens for the whole app from its
// manifest, below the page's own styles. The trip demo's Plum sample is one.
export default async function ({ a, check, openTab, URL }) {
  const install = (source) => a.evaluate((s) => window.__host.command("install", s), source);
  const noPermission = await install('export const manifest = { id: "th1", name: "T", permissions: [], theme: { "--accent": "red" } };\nexport default () => {};');
  const loads = await install('export const manifest = { id: "th2", name: "T", permissions: ["ui:theme"], theme: { "--bg": "url(https://example.com/x.png)" } };\nexport default () => {};');
  const unknown = await install('export const manifest = { id: "th3", name: "T", permissions: ["ui:theme"], theme: { "--space-4": "40px" } };\nexport default () => {};');
  const breaks = await install('export const manifest = { id: "th4", name: "T", permissions: ["ui:theme"], theme: { "--fg": "red; } body { display: none" } };\nexport default () => {};');
  check(
    "a theme needs ui:theme, and sets only known tokens to plain values",
    noPermission.ok === false && /ui:theme/.test(noPermission.error) && loads.ok === false && unknown.ok === false && breaks.ok === false,
    [noPermission.error, loads.error, unknown.error, breaks.error].join(" | "),
  );

  const page = await openTab(`${URL}demos/trip/app.html`);
  const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  const before = await accent();
  const added = await page.evaluate(() => window.__host.command("user:add", { app: "demos/trip", url: "/demos/trip/samples/plum.js" }));
  await page.evaluate(() => window.__host.command("user:on", { app: "demos/trip", id: "plum" }));
  const themed = await page.waitForFunction((b) => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() !== b, before, { timeout: 8000 }).then(() => accent(), () => before);
  // The page's own style still wins.
  const pageWins = await page.evaluate(() => {
    const style = document.head.appendChild(Object.assign(document.createElement("style"), { textContent: ":root { --accent: rgb(1, 2, 3); }" }));
    const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    style.remove();
    return value;
  });
  await page.evaluate(() => window.__host.command("user:off", { app: "demos/trip", id: "plum" }));
  const after = await page.waitForFunction((b) => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === b, before, { timeout: 8000 }).then(() => accent(), () => "still themed");
  await page.evaluate(() => window.__host.command("user:remove", { app: "demos/trip", id: "plum" }));
  check(
    "a theme plugin restyles the whole app, under the page's own styles, until it is turned off",
    added?.ok && themed !== before && /7c3aed|124, 58, 237/.test(themed) && pageWins === "rgb(1, 2, 3)" && after === before,
    JSON.stringify({ before, themed, pageWins, after }),
  );
  await page.close();
}
