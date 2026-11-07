// Habits: owns the `habits` collection. Each habit keeps the days it was
// done, as a list of dates ("2026-11-07"), so ticking today adds today's
// date and unticking takes it away. The streak is counted from those dates.
//
// The list is a live view: the function given to views.live reads the
// habits, so any change to them, from this tab or another, draws it again.

export const manifest = {
  id: "habits",
  name: "Habits",
  description: "Tick off today's habits, and keep a streak.",
  version: "1.0.0",
  permissions: ["ui"],
  collections: {
    habits: {
      title: "Habits",
      schema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", title: "Habit", maxLength: 80 },
          days: { type: "array", title: "Days done", items: { type: "string", format: "date" } },
        },
      },
    },
  },
};

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** How many days in a row, ending today (or yesterday, if today isn't done yet). */
export function streak(days, today = new Date()) {
  const done = new Set(days);
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!done.has(iso(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  for (; done.has(iso(d)); d.setDate(d.getDate() - 1)) n++;
  return n;
}

export default async function (ctx) {
  const views = ctx.ui.views("habits.html");

  views.live("main", "habits", async (ctx) => {
    const today = iso(new Date());
    const habits = (await ctx.call("data", "list", "habits")).sort((a, b) => a.name.localeCompare(b.name));
    return {
      habits: habits.map((h) => {
        const n = streak(h.days ?? []);
        return { id: h.id, name: h.name, today: (h.days ?? []).includes(today), streak: n && (n === 1 ? "1 day" : `${n} days`) };
      }),
    };
  });

  // "tick:<id>" comes from a habit's checkbox, with true or false.
  ctx.ui.onEvent(async (action, value) => {
    if (!action.startsWith("tick:")) return;
    const habit = await ctx.call("data", "get", "habits", action.slice(5));
    if (!habit) return;
    const today = iso(new Date());
    const days = (habit.days ?? []).filter((d) => d !== today);
    await ctx.call("data", "put", "habits", { ...habit, days: value === true ? [...days, today] : days });
  });
}
