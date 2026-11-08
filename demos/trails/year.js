// Year: a year of activity as a heatmap, a square per day, a column per week.
// It reads the log (data:read:activities) and draws live. How dark a square
// is comes from data-level="0"…"4", which year.html's CSS turns into a
// colour, so the template needs no style attributes and no numbers in CSS.
//
// The squares are a CSS grid that fills column by column (grid-auto-flow:
// column), seven rows to a week, Monday at the top.

export const manifest = {
  id: "year",
  name: "Year",
  description: "A year of activity, a square a day.",
  version: "1.0.0",
  permissions: ["ui", "data:read:activities"],
  order: 20,
};

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** How dark a day's square is, from the distance covered: 0 (nothing) to 4. Rides count for a third, swims for four times. */
export function level(km) {
  if (!km) return 0;
  if (km < 5) return 1;
  if (km < 10) return 2;
  if (km < 18) return 3;
  return 4;
}
const EFFORT = { run: 1, hike: 1, ride: 1 / 3, swim: 4 };

/** The longest run of consecutive active days in `days` (a Set of YYYY-MM-DD), and the one ending today or yesterday. */
export function streaks(days, today = new Date()) {
  let longest = 0;
  let run = 0;
  let current = 0;
  for (let back = 365; back >= 0; back--) {
    const d = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back));
    run = days.has(d) ? run + 1 : 0;
    longest = Math.max(longest, run);
    // A streak that reached yesterday still counts until today is over.
    if (back <= 1 && run) current = run;
  }
  return { longest, current };
}

export default async function (ctx) {
  const views = ctx.ui.views("year.html");
  const year = views.live("year", "year", async (api) => {
    const today = new Date();
    const byDay = new Map();
    for (const a of await api.call("data", "list", "activities")) {
      const day = byDay.get(a.date) ?? { km: 0, effort: 0, titles: [] };
      day.km += a.km;
      day.effort += a.km * (EFFORT[a.kind] ?? 1);
      day.titles.push(`${a.title} (${a.km} km)`);
      byDay.set(a.date, day);
    }
    // Start on the Monday 52 weeks back, so the last column is this week.
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7 * 52);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const days = [];
    const months = [];
    for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const key = iso(d);
      const day = byDay.get(key);
      days.push({ date: key, level: level(day?.effort), title: day ? `${key}: ${day.titles.join(", ")}` : `${key}: rest day`, today: key === iso(today) });
      // A month label over the first week that starts in it.
      // Counted in days, not milliseconds, so a clock change doesn't shift it a column.
      if (d.getDay() === 1 && d.getDate() <= 7) months.push({ name: d.toLocaleDateString(undefined, { month: "short" }), week: Math.floor((days.length - 1) / 7) + 1 });
    }
    // The same days the grid shows: from its first Monday through today, so a future date doesn't count yet.
    const shown = (k) => k >= iso(start) && k <= iso(today);
    const active = new Set([...byDay.keys()].filter(shown));
    const total = [...byDay.entries()].filter(([k]) => shown(k)).reduce((sum, [, v]) => sum + v.km, 0);
    return { days, months, active: active.size, total: Math.round(total).toLocaleString(), ...streaks(active, today), legend: [0, 1, 2, 3, 4].map((l) => ({ l })) };
  });
  // Today's square, the range and the streaks move on with the calendar: draw again at each local midnight.
  const atMidnight = () => {
    const now = new Date();
    setTimeout(() => {
      year.refresh();
      atMidnight();
    }, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now + 1000);
  };
  atMidnight();
}
