// Data-driven sizes (src/host/sanitize.ts): a view's `style` attribute keeps
// only custom properties set to numbers, so a plugin's CSS can size a bar
// from data with var(), in every browser. Everything else in it is dropped.

export default async function ({ a, check, openTab, URL }) {
  await a.evaluate(() => window.__host.command("install", `export const manifest = { id: 'stylecheck', name: 'Style check', permissions: ['ui'] };
export default (ctx) => ctx.ui.render('devtools', 'bars', \`
  <p data-test="kept" style="--pct: 40; --w: 12.5rem; --turn: -0.25turn">kept</p>
  <p data-test="mixed" style="color: red; --pct: 60; background: url(https://example.com/x.png); --evil: url(https://example.com/y.png); --x: 1; } p { color: red">mixed</p>
  <p data-test="none" style="width: 10px">none</p>
  <p data-test="many" style="--a:1;--b:2;--c:3;--d:4;--e:5;--f:6;--g:7;--h:8;--i:9">many</p>\`);`));
  const view = '#devtools [data-key="stylecheck:bars"]';
  await a.waitForSelector(`${view} [data-test="kept"]`, { timeout: 5000 });
  const styles = await a.evaluate((sel) => Object.fromEntries([...document.querySelectorAll(`${sel} [data-test]`)].map((el) => [el.dataset.test, el.getAttribute("style")])), view);
  check(
    "a view's style attribute keeps only custom properties set to numbers, at most 8",
    styles.kept === "--pct: 40; --w: 12.5rem; --turn: -0.25turn" && styles.mixed === "--pct: 60; --x: 1" && styles.none === null && styles.many?.split(";").length === 8,
    JSON.stringify(styles),
  );
  await a.evaluate(() => window.__host.command("uninstall", "stylecheck"));

  // The board's pulse sizes its ring this way.
  const page = await openTab(`${URL}demos/board/app.html`);
  const ring = await page.waitForSelector('[data-plugin="pulse"] .ring', { timeout: 8000 }).then((el) => el.evaluate((r) => ({ style: r.getAttribute("style"), pct: getComputedStyle(r).getPropertyValue("--pct").trim(), text: r.textContent.trim() })), () => null);
  check("the board's pulse ring is sized by --pct from its data", !!ring && ring.style === `--pct: ${parseInt(ring.text)}` && ring.pct === String(parseInt(ring.text)), JSON.stringify(ring));
  await page.close();
}
