// Glowfall: the game loop (std/game) runs the game's systems, each a plugin.
// Start it, steer with a key, and the jar moves on the next tick; things
// fall; pausing stops the clock. The ticks are quiet: none of them is in the
// trace.
export default async function (page, { check }) {
  const games = () => page.evaluate(() => window.__host.command("game-state"));
  const glowfall = async () => (await games()).find((g) => g.game === "glowfall");
  const until = async (test, ms = 8000) => {
    for (let end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(100)) {
      const game = await glowfall();
      if (game && test(game)) return game;
    }
    return glowfall();
  };
  await page.click('[data-key^="glowfall-controls"] button[data-action="start"]');
  const started = await until((g) => g.tick > 5);
  check("Glowfall starts: the loop ticks, run by the controls plugin", started?.tick > 5 && started.by === "glowfall-controls", JSON.stringify(started)?.slice(0, 200));
  await page.locator("body").press("ArrowRight");
  const moved = await until((g) => g.state.jar === 3);
  check("a key press reaches the jar system as input on the next tick, and the jar moves a lane", moved?.state.jar === 3, JSON.stringify(moved?.state)?.slice(0, 200));
  const falling = await until((g) => g.state.things.length > 0);
  check("the sky system drops things, and they fall", falling?.state.things.length > 0);
  check("the meadow draws on a canvas in its own worker", await page.locator('[data-plugin="glowfall-meadow"] canvas').count().then((n) => n > 0));
  const traced = await page.evaluate(() => window.__host.traces.filter((e) => /^game:(update|rules|frame)$/.test(e.name)).length);
  check("the ticks are quiet hooks: none of them fills the trace", traced === 0, `${traced} traced`);
  await page.click('[data-key^="glowfall-controls"] button[data-action="pause"]');
  const paused = await until((g) => g.paused);
  await page.waitForTimeout(400);
  const still = await glowfall();
  check("pausing stops the clock", paused?.paused && still?.tick === paused.tick, `${paused?.tick} → ${still?.tick}`);
}
