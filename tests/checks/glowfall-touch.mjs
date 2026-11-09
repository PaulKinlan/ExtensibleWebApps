// Glowfall by touch: the meadow's canvas is drawn with `pointer`, so a tap or
// a drag on it reaches the plugin (canvas:pointer, in the canvas's own
// pixels), and the jar goes to the lane under the finger.
export default async function ({ check, openTab, URL }) {
  const page = await openTab(`${URL}demos/glowfall/app.html`);
  const glowfall = async () => (await page.evaluate(() => window.__host.command("game-state"))).find((g) => g.game === "glowfall");
  const until = async (test, ms = 6000) => {
    for (let end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(100)) {
      const game = await glowfall();
      if (game && test(game)) return game;
    }
    return glowfall();
  };
  const canvas = page.locator('[data-plugin="glowfall-meadow"] canvas');
  await canvas.waitFor({ timeout: 8000 });
  check("the meadow's canvas takes touch: the page doesn't scroll under a finger on it", (await canvas.evaluate((el) => getComputedStyle(el).touchAction)) === "none");
  await page.click('[data-key^="glowfall-controls"] button[data-action="start"]');
  await until((g) => g.tick > 3);
  const box = await canvas.boundingBox();
  // A tap in the first of the five lanes.
  await page.mouse.click(box.x + box.width * 0.08, box.y + box.height * 0.6);
  const tapped = await until((g) => g.state.jar === 0);
  check("a tap on the canvas moves the jar to the lane under it", tapped?.state.jar === 0, `jar ${tapped?.state.jar}`);
  // A drag across to the last lane.
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.6, { steps: 8 });
  const dragged = await until((g) => g.state.jar === 4);
  await page.mouse.up();
  check("a drag along the canvas steers the jar with it", dragged?.state.jar === 4, `jar ${dragged?.state.jar}`);
  await page.close();
}
