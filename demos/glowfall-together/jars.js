// Jars: one for each player, on the space's server. Like Glowfall's own
// jar.js, a system on the game loop's game:update, but each move says whose
// jar it is (player: the device it came from, which the space's server puts
// on every live message, so no one moves another's jar). Players join and
// leave as the game goes on.

export const manifest = {
  id: "glowfall-jars",
  name: "Jars for everyone",
  description: "Moves each player's jar a lane, or to the lane they tapped.",
  version: "1.0.0",
  runs: "server",
  permissions: ["hook:intercept:game:update"],
  services: ["game"],
};

export default function (ctx) {
  ctx.on("game:update", ({ game, input, state }) => {
    if (game !== "glowfall" || !state.players || state.done || !input.length) return;
    const lanes = state.lanes ?? 7;
    const players = { ...state.players };
    for (const move of input) {
      const who = move.player;
      if (typeof who !== "string") continue;
      if (move.type === "join" && !players[who]) players[who] = { member: move.member ?? "", colour: move.colour ?? "#ffffff", jar: Math.floor(lanes / 2), score: 0 };
      if (move.type === "leave") delete players[who];
      const p = players[who];
      if (!p) continue;
      let jar = p.jar;
      if (move.type === "left") jar = Math.max(0, jar - 1);
      if (move.type === "right") jar = Math.min(lanes - 1, jar + 1);
      if (move.type === "lane" && Number.isInteger(move.lane)) jar = Math.min(lanes - 1, Math.max(0, move.lane));
      players[who] = { ...p, jar };
    }
    return { state: { ...state, players } };
  });
}
