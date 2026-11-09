// Controls: Start, Pause, and the two buttons that steer the jar, with keys
// for each (the command palette lists them). It starts the game: the state
// every system works on begins here, and the loop (std/game) runs it. When
// the game ends it keeps the score, and shows the best.
//
// Every press goes to the loop as input (game.input), which hands it to the
// systems on the next tick: jar.js is the one that moves the jar.

export const manifest = {
  id: "glowfall-controls",
  name: "Controls",
  description: "Start, pause and steer, by button or key, and the best scores.",
  version: "1.0.0",
  permissions: ["ui", "game", "commands", "hook:listen:game:ended", "hook:listen:game:started"],
  services: ["game", "commands"],
  order: 20,
  collections: {
    "glowfall-scores": {
      title: "Glowfall scores",
      schema: {
        type: "object",
        required: ["score"],
        properties: {
          score: { type: "integer", minimum: 0, title: "Fireflies" },
          at: { type: "string", title: "When" },
        },
      },
    },
  },
};

const GAME = "glowfall";
const START = { lanes: 5, jar: 2, things: [], next: 1, score: 0, lives: 3, speed: 0.35 };

export default async function (ctx) {
  const views = ctx.ui.views("controls.html");
  let running = false;
  let paused = false;

  // Drawn again when a score is kept (the collection changes) or the game starts, pauses or ends (refresh).
  let view;
  const draw = () => view?.refresh();

  const start = async () => {
    await ctx.call("game", "start", { game: GAME, hz: 20, state: START });
    running = true;
    paused = false;
    draw();
    return "Started";
  };
  const pause = async () => {
    if (!running) return "Nothing to pause";
    ({ paused } = await ctx.call("game", "pause", { game: GAME, paused: !paused }));
    draw();
    return paused ? "Paused" : "Carrying on";
  };
  const steer = (type) => async () => {
    if (!running || paused) return;
    await ctx.call("game", "input", { game: GAME, type });
  };

  ctx.on("game:started", ({ game }) => {
    if (game !== GAME) return;
    running = true;
    draw();
  });
  ctx.on("game:ended", async ({ game, state, reason }) => {
    if (game !== GAME) return;
    running = false;
    paused = false;
    if (reason !== "stopped" && state?.done) await ctx.call("data", "put", "glowfall-scores", { score: state.score ?? 0, at: new Date().toISOString() });
    draw();
  });

  ctx.commands.add({ id: "start", title: "Start a new game", group: "Glowfall", keys: ["Enter"] }, start);
  ctx.commands.add({ id: "pause", title: "Pause or carry on", group: "Glowfall", keys: ["p"] }, pause);
  ctx.commands.add({ id: "left", title: "Jar left", group: "Glowfall", keys: ["ArrowLeft"] }, steer("left"));
  ctx.commands.add({ id: "right", title: "Jar right", group: "Glowfall", keys: ["ArrowRight"] }, steer("right"));

  ctx.ui.onEvent((action) => {
    if (action === "start") return start();
    if (action === "pause") return pause();
    if (action === "left" || action === "right") return steer(action)();
  });

  // A game still running from before this plugin started (another tab started it) is picked up.
  const now = await ctx.call("game", "state", { game: GAME });
  running = now.running;
  paused = !!now.paused;
  view = views.live("side", "controls", async (c) => {
    const scores = (await c.call("data", "list", "glowfall-scores")).sort((a, b) => b.score - a.score);
    return { running, stopped: !running, paused, best: scores[0]?.score ?? 0, top: scores.slice(0, 5), played: scores.length };
  });
}
