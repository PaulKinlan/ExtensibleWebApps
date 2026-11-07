// Countdown: a plugin a person adds to the trip page, which has no slot for
// it. It names one place in its manifest, after the page's heading, and
// draws there as it would in a slot. It reads the trip's start date from the
// heading's data-start, through page.matches.
//
// `files` lists what comes with it when it is added from a URL: its
// template, and an image the template shows. Both are then served from the
// person's own copy on this device, at /user/demos/trip/.

export const manifest = {
  id: "countdown",
  name: "Countdown",
  description: "How many days until the trip, under the heading.",
  version: "1.0.0",
  permissions: ["ui"],
  places: {
    days: { at: "h1[data-start]", put: "after" },
  },
  files: ["countdown.html", "tram.svg"],
};

const DAY = 24 * 60 * 60 * 1000;

export default async function (ctx) {
  const views = ctx.ui.views("countdown.html");
  const [heading] = await ctx.call("page", "matches", "days");
  const start = heading?.data.start;
  if (!start) return views.render("days", "missing");
  const today = new Date(new Date().toDateString()).getTime();
  const days = Math.round((new Date(`${start}T00:00:00`).getTime() - today) / DAY);
  views.render("days", "days-left", {
    words: days > 1 ? `${days} days to go` : days === 1 ? "Tomorrow!" : days === 0 ? "Today!" : "Hope it was a good one",
  });
}
