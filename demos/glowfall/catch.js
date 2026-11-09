// Catch: the rules. Once everything has moved (game:rules runs after every
// game:update), it looks at what reached the jar's rim: a firefly in the
// jar's lane is caught, a point, and makes things fall a little faster; a
// raindrop in the jar's lane puts out one of the three lights. With none
// left, the game is over: answering { over } tells the loop to stop.
//
// It notes the latest catch and splash (state.caught, state.splashed, with
// the tick), so whatever draws the game or plays a sound for it can tell.

export const manifest = {
  id: "glowfall-catch",
  name: "Catch",
  description: "Scores the fireflies the jar catches and counts the raindrops it doesn't dodge.",
  version: "1.0.0",
  permissions: ["hook:intercept:game:rules"],
  services: ["game"],
};

/** Where the jar's rim is, from the top (0) to the bottom (1). */
const RIM = 0.88;

export default function (ctx) {
  ctx.on("game:rules", ({ game, tick, state }) => {
    if (game !== "glowfall" || state.done) return;
    const jar = state.jar ?? 2;
    let { score = 0, lives = 3, speed = 0.35, caught = null, splashed = null } = state;
    const things = [];
    for (const t of state.things ?? []) {
      const atRim = t.y >= RIM && t.y < RIM + 0.12 && Math.abs(t.x - jar) < 0.5;
      if (!atRim) {
        things.push(t);
        continue;
      }
      if (t.kind === "firefly") {
        score++;
        speed = Math.min(0.9, speed + 0.012);
        caught = { tick, x: t.x };
      } else {
        lives--;
        splashed = { tick, x: t.x };
      }
    }
    const done = lives <= 0;
    return { state: { ...state, things, score, lives: Math.max(0, lives), speed, caught, splashed, done }, ...(done ? { over: `${score} caught` } : {}) };
  });
}
