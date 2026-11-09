// Wind: a person's own rule for Glowfall. Every few seconds a gust blows
// through and pushes what falls a lane to one side, so a firefly you were
// under drifts away. The game doesn't know about wind: this is one more
// system on the loop's game:update hook, and turning it off takes the wind
// away again.

export const manifest = {
  id: "glowfall-wind",
  name: "Wind",
  description: "Gusts that blow falling things sideways.",
  version: "1.0.0",
  permissions: ["hook:intercept:game:update"],
  services: ["game"],
};

export default function (ctx) {
  ctx.on("game:update", ({ game, dt, time, state }) => {
    if (game !== "glowfall" || state.done) return;
    const lanes = state.lanes ?? 5;
    // A gust lasts two seconds in every six, one way and then the other.
    const phase = time % 6;
    const gust = phase < 2 ? Math.sin((phase / 2) * Math.PI) * (Math.floor(time / 6) % 2 ? 1 : -1) : 0;
    if (!gust) return { state: { ...state, wind: 0 } };
    const things = (state.things ?? []).map((t) => ({ ...t, x: Math.min(lanes - 1, Math.max(0, t.x + gust * 0.9 * dt)) }));
    return { state: { ...state, things, wind: gust } };
  });
}
