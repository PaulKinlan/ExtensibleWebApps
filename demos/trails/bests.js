// Bests: personal records from the log, as tiles in the side column. It
// reads the log and draws live, so a new longest ride shows the moment it's
// saved. Each tile names the activity it came from.

export const manifest = {
  id: "bests",
  name: "Personal bests",
  description: "Longest, fastest and highest, from the log.",
  version: "1.0.0",
  permissions: ["ui", "data:read:activities"],
  order: 40,
};

const when = (date) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
/** Minutes as "m:ss", rounded to the second first so 12:59.7 shows as 13:00, not 12:60. */
const minSec = (minutes) => {
  const s = Math.round(minutes * 60);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const best = (list, score) => list.reduce((top, a) => (top === null || score(a) > score(top) ? a : top), null);

export default async function (ctx) {
  const bests = ctx.ui.views("bests.html").live("side", "bests", async (api) => {
    const all = await api.call("data", "list", "activities");
    const of = (kind) => all.filter((a) => a.kind === kind);
    const tile = (id, label, a, value, unit) => (a ? { id, label, value, unit, from: `${a.title}, ${when(a.date)}`, kind: a.kind } : null);
    const run = best(of("run"), (a) => a.km);
    const ride = best(of("ride"), (a) => a.km);
    const climb = best(all, (a) => a.climb ?? 0);
    // Fastest pace over a run of 5 km or more.
    const fast = best(of("run").filter((a) => a.km >= 5), (a) => a.km / a.minutes);
    const pace = fast ? fast.minutes / fast.km : 0;
    const swim = best(of("swim"), (a) => a.km);
    // This month by the local calendar (toISOString would give UTC's month near midnight).
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const thisMonth = all.filter((a) => a.date.startsWith(month));
    return {
      month: Math.round(thisMonth.reduce((s, a) => s + a.km, 0)),
      sessions: thisMonth.length,
      tiles: [
        tile("run", "Longest run", run, run?.km.toFixed(1), "km"),
        tile("ride", "Longest ride", ride, ride?.km.toFixed(1), "km"),
        tile("pace", "Fastest 5k+", fast, minSec(pace), "/km"),
        tile("climb", "Biggest climb", climb, climb?.climb?.toLocaleString(), "m"),
        tile("swim", "Longest swim", swim, swim?.km.toFixed(1), "km"),
      ].filter(Boolean),
    };
  });
  // "This month" moves on with the calendar: draw again at each local midnight.
  const atMidnight = () => {
    const now = new Date();
    setTimeout(() => {
      bests.refresh();
      atMidnight();
    }, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now + 1000);
  };
  atMidnight();
}
