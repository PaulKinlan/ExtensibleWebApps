// World clock: a plugin a person adds to any app from the registry. It draws
// a small strip of clocks at the foot of the page (a place, so the app needs
// no slot for it), and asks the clock service (packages/clock/) for each time.
// Its manifest says it needs `clock`, so it doesn't start without it; adding it
// from Customize's list adds the clock too.

export const manifest = {
  id: "world-clock",
  name: "World clock",
  description: "The time in London, New York and Tokyo, at the foot of the page.",
  version: "1.0.0",
  permissions: ["ui", "clock"],
  services: ["clock"],
  places: {
    strip: { at: "main", put: "append" },
  },
  files: ["world-clock.html"],
};

const ZONES = [
  ["London", "Europe/London"],
  ["New York", "America/New_York"],
  ["Tokyo", "Asia/Tokyo"],
];

export default function (ctx) {
  const views = ctx.ui.views("world-clock.html");
  const draw = async () => {
    const clocks = await Promise.all(ZONES.map(async ([city, zone]) => ({ city, ...(await ctx.call("clock", "now", zone)) })));
    views.render("strip", "clocks", { clocks });
  };
  void draw();
  setInterval(draw, 30_000);
}
