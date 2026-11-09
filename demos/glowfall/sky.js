// Sky: what falls. Each tick it may drop a new firefly or a raindrop at the
// top of a lane, and moves everything down. It knows nothing of the jar or
// the score: catch.js judges what lands, and the more is caught, the faster
// this lets things fall (state.speed, which catch.js raises).
//
// A system: a plugin that listens to the game loop's game:update hook (std/game)
// and answers with the state, changed. Turn it off in Customize and nothing
// falls; the rest of the game carries on.
//
// It runs in the browser and on a space's server (runs: "both"), so Glowfall
// together (demos/glowfall-together/) uses this same plugin for its sky,
// beside its own systems for many jars. On a server it does nothing until a
// game named glowfall runs there.

export const manifest = {
  id: "glowfall-sky",
  name: "Sky",
  description: "Drops fireflies and raindrops down the five lanes.",
  version: "1.0.0",
  runs: "both",
  permissions: ["hook:intercept:game:update"],
  services: ["game"],
};

/** The chance, each tick, that a new thing falls; and how many fall at once at most. */
const CHANCE = 0.12;
const MOST = 7;

export default function (ctx) {
  ctx.on("game:update", ({ game, dt, time, state }) => {
    if (game !== "glowfall" || state.done) return;
    const lanes = state.lanes ?? 5;
    const speed = state.speed ?? 0.35;
    // Everything falls; what has fallen past the bottom is gone.
    const things = (state.things ?? []).map((t) => ({ ...t, y: t.y + speed * (t.kind === "drop" ? 1.35 : 1) * dt })).filter((t) => t.y < 1.15);
    let next = state.next ?? 1;
    // Something new, now and then, in a lane where nothing has just started falling.
    if (things.length < MOST && Math.random() < CHANCE + Math.min(time / 300, 0.1)) {
      const lane = Math.floor(Math.random() * lanes);
      if (!things.some((t) => Math.round(t.x) === lane && t.y < 0.25)) {
        const drop = Math.random() < Math.min(0.2 + time / 200, 0.45);
        things.push({ id: next++, kind: drop ? "drop" : "firefly", x: lane, y: -0.05, seed: Math.random() });
      }
    }
    return { state: { ...state, things, next } };
  });
}
