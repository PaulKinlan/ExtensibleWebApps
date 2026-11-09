// Catches: the rules when everyone plays. A firefly that reaches a jar's rim
// is that player's, and the team's; with jars side by side, the first in the
// list gets it. Rain that reaches the rim where any jar is puts out one of the
// team's lights. With none left, the game is over.

export const manifest = {
  id: "glowfall-catches",
  name: "Catches for everyone",
  description: "Scores each player's catches and the team's, and counts the rain.",
  version: "1.0.0",
  runs: "server",
  permissions: ["hook:intercept:game:rules"],
  services: ["game"],
};

const RIM = 0.88;

export default function (ctx) {
  ctx.on("game:rules", ({ game, tick, state }) => {
    if (game !== "glowfall" || !state.players || state.done) return;
    const players = { ...state.players };
    let { team = 0, lives = 5, speed = 0.3, caught = null, splashed = null } = state;
    const things = [];
    for (const t of state.things ?? []) {
      const atRim = t.y >= RIM && t.y < RIM + 0.12;
      const who = atRim ? Object.keys(players).find((id) => Math.abs(t.x - players[id].jar) < 0.5) : undefined;
      if (!who) {
        things.push(t);
        continue;
      }
      if (t.kind === "firefly") {
        players[who] = { ...players[who], score: (players[who].score ?? 0) + 1 };
        team++;
        speed = Math.min(0.9, speed + 0.01);
        caught = { tick, x: t.x, by: who };
      } else {
        lives--;
        splashed = { tick, x: t.x, by: who };
      }
    }
    const done = lives <= 0;
    return { state: { ...state, players, things, team, lives: Math.max(0, lives), speed, caught, splashed, done }, ...(done ? { over: `${team} caught together` } : {}) };
  });
}
