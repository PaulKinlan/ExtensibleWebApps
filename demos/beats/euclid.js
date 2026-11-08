// Euclid: fills a row with hits spread as evenly as they go, the Euclidean
// rhythms found in drumming all over the world (3 in 8 is the tresillo,
// 5 in 16 the bossa nova). It draws a small menu in the room the sequencer
// leaves beside each row's name (<slot name="sequencer.track.tools">).
//
// It doesn't write the pattern itself. It runs the sequencer's own command,
// sequencer/set-track, which runs with the sequencer's rights: so this
// plugin needs only the `commands` permission, and the person isn't asked
// to review every pad, as they would be for a write to data it doesn't own.

export const manifest = {
  id: "euclid",
  name: "Euclidean rhythms",
  description: "Spreads a number of hits evenly across a row.",
  version: "1.0.0",
  permissions: ["ui", "commands"],
  order: 20,
};

const SLOT = "sequencer.track.tools";

/** `hits` spread over `steps` as evenly as they go, as "x" and ".", starting on a hit: euclid(3, 8) is "x..x..x.". */
export function euclid(hits, steps = 16) {
  let out = "";
  for (let i = 0; i < steps; i++) out += (i * hits) % steps < hits ? "x" : ".";
  return out;
}

export default async function (ctx) {
  const views = ctx.ui.views("euclid.html");
  const fill = async () => {
    const slots = await ctx.call("page", "slots", SLOT);
    slots.forEach(({ data }, i) => views.render(`${SLOT}#${i}`, "menu", { track: data.track, choices: [0, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 16].map((n) => ({ n })) }));
  };
  ctx.ui.onEvent(async (action, value) => {
    if (action === "slot:changed") return void fill();
    const [verb, track] = action.split(":");
    if (verb !== "euclid" || value === "") return;
    await ctx.call("commands", "run", "sequencer/set-track", { track, steps: euclid(Number(value)) });
    fill(); // put the menu back to its label
  });
  await fill();
}
