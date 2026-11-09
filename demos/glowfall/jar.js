// Jar: the one thing the person steers. It reads what they pressed since the
// last tick (input from std/game, sent by controls.js) and moves the jar a
// lane to the left or right for each press.

export const manifest = {
  id: "glowfall-jar",
  name: "Jar",
  description: "Moves the jar a lane left or right for each press.",
  version: "1.0.0",
  permissions: ["hook:intercept:game:update"],
  services: ["game"],
};

export default function (ctx) {
  ctx.on("game:update", ({ game, input, state }) => {
    if (game !== "glowfall" || state.done || !input.length) return;
    const lanes = state.lanes ?? 5;
    let jar = state.jar ?? Math.floor(lanes / 2);
    for (const press of input) {
      if (press.type === "left") jar = Math.max(0, jar - 1);
      if (press.type === "right") jar = Math.min(lanes - 1, jar + 1);
      if (press.type === "lane" && Number.isInteger(press.lane)) jar = Math.min(lanes - 1, Math.max(0, press.lane));
    }
    return { state: { ...state, jar } };
  });
}
