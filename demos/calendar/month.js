// Month: draws one month of events as a grid. It reads the events
// (`data:read:events`) and hears changes to them. Which month is showing is
// this plugin's own state, kept in ctx.storage so it survives a reload; the
// buttons send "prev", "next" and "today".
//
// The grid is a table: a row per week, Monday first, with the days from the
// months either side to fill it. The template is two nested loops
// (weeks, then days); the page styles it through aria-current and data-other.

export const manifest = {
  id: "month",
  name: "Month",
  description: "A month of events as a grid.",
  version: "1.0.0",
  permissions: ["ui", "data:read:events", "hook:listen:data:changed:events"],
  order: 10,
};

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The weeks of the month holding `first`: [[{ date, day, other, current }, …7], …]. */
export function weeks(first, today = new Date()) {
  const start = new Date(first.getFullYear(), first.getMonth(), 1);
  start.setDate(1 - ((start.getDay() + 6) % 7)); // back to Monday
  const out = [];
  for (const d = new Date(start); out.length < 6; ) {
    const week = [];
    for (let i = 0; i < 7; i++, d.setDate(d.getDate() + 1)) {
      week.push({ date: iso(d), day: d.getDate(), other: d.getMonth() !== first.getMonth(), current: iso(d) === iso(today) ? "date" : "false" });
    }
    out.push(week);
    // Stop once the month is over, so a month uses 4 to 6 rows.
    if (d.getMonth() !== first.getMonth()) break;
  }
  return out;
}

export default async function (ctx) {
  const views = ctx.ui.views("month.html");
  const now = new Date();
  // Months are counted from now: 0 is this month, -1 last month.
  let offset = Number(await ctx.storage.get("offset")) || 0;

  const draw = async () => {
    const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const byDate = new Map();
    for (const e of await ctx.call("data", "list", "events")) {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    }
    for (const list of byDate.values()) list.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
    const grid = weeks(first, now).map((week) => week.map((d) => ({ ...d, events: byDate.get(d.date) ?? [] })));
    views.render("main", "grid", {
      title: first.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      weeks: grid,
      away: offset !== 0,
    });
  };

  ctx.ui.onEvent(async (action) => {
    if (action === "prev") offset--;
    if (action === "next") offset++;
    if (action === "today") offset = 0;
    await ctx.storage.set("offset", offset);
    draw();
  });
  ctx.on("data:changed:events", () => draw());
  draw();
}
