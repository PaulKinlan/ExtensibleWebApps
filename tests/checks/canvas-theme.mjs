// Canvas theme (src/host/canvas-theme.ts): a plugin's canvas comes with the page's theme, its colours resolved,
// since a worker can't read CSS, and the theme comes again when it changes.
export default async function ({ a, check }) {
  const source = `export const manifest = { id: "theme-canvas", name: "Theme canvas", permissions: ["ui"], scope: "tab" };
export default (ctx) => {
  ctx.ui.render("status", "theme-canvas", { type: "canvas", id: "c", width: 10, height: 10 });
  ctx.ui.onCanvas("c", (canvas, theme) => ctx.log("theme-first " + JSON.stringify(theme)));
  ctx.ui.onTheme((theme) => ctx.log("theme-again " + JSON.stringify(theme)));
};`;
  const log = (prefix) =>
    a
      .waitForFunction((p) => window.__host.traces.findLast((e) => e.plugin?.startsWith("theme-canvas") && e.detail?.startsWith(p)), prefix, { timeout: 5000 })
      .then((h) => h.jsonValue())
      .then((e) => e.detail, () => "");
  try {
    const scheme = await a.evaluate(() => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
    await a.evaluate((s) => window.__host.command("install", s), source);
    const first = await log("theme-first");
    const firstTheme = first ? JSON.parse(first.slice(12)) : null;
    check(
      "a canvas comes with the page's theme: light or dark as shown, its colours resolved, and its font",
      firstTheme?.scheme === scheme && /^rgb/.test(firstTheme.colors.fg) && /^rgb/.test(firstTheme.colors.bg) && firstTheme.colors.fg !== firstTheme.colors.bg && Boolean(firstTheme.font),
      first,
    );
    const flipped = scheme === "dark" ? "light" : "dark";
    await a.emulateMedia({ colorScheme: flipped });
    const again = await a
      .waitForFunction((s) => window.__host.traces.findLast((e) => e.plugin?.startsWith("theme-canvas") && e.detail?.startsWith(`theme-again {"scheme":"${s}"`)), flipped, { timeout: 5000 })
      .then((h) => h.jsonValue())
      .then((e) => e.detail, () => "");
    const againTheme = again ? JSON.parse(again.slice(12)) : null;
    check("when light and dark flip, the plugin hears the new theme, in new colours", againTheme?.scheme === flipped && againTheme.colors.fg !== firstTheme?.colors.fg, `${first} | ${again}`);
    // A token set on <body>, then a stylesheet that was off (media="not all") turned on: each is heard.
    const accent = (rgb) =>
      a
        .waitForFunction((c) => window.__host.traces.findLast((e) => e.plugin?.startsWith("theme-canvas") && e.detail?.startsWith("theme-again") && e.detail.includes(`"accent":"${c}"`)), rgb, { timeout: 5000 })
        .then(() => true, () => false);
    await a.evaluate(() => document.body.style.setProperty("--accent", "rgb(1, 2, 3)"));
    const byBody = await accent("rgb(1, 2, 3)");
    await a.evaluate(() => {
      document.body.style.removeProperty("--accent");
      const style = Object.assign(document.createElement("style"), { id: "theme-canvas-off", media: "not all", textContent: "body { --accent: rgb(4, 5, 6) }" });
      document.head.append(style);
    });
    await a.waitForTimeout(100);
    await a.evaluate(() => (document.getElementById("theme-canvas-off").media = "all"));
    const byMedia = await accent("rgb(4, 5, 6)");
    check("a token set on <body>, or a stylesheet's media changed, reaches the plugin too", byBody && byMedia, JSON.stringify({ byBody, byMedia }));
  } finally {
    await a.emulateMedia({ colorScheme: null });
    await a.evaluate(() => document.getElementById("theme-canvas-off")?.remove()).catch(() => {});
    await a.evaluate(() => window.__host.command("uninstall", "theme-canvas")).catch(() => {});
  }
}
