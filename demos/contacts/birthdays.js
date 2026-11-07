// Birthdays: reads the contacts (`data:read:contacts`) and lists the
// birthdays in the next few weeks. It is a live view: the function it gives
// views.live reads the contacts and the settings, and runs again whenever
// either changes. How far ahead to look is a setting, so the plugins
// panel draws a field for it.

export const manifest = {
  id: "birthdays",
  name: "Birthdays",
  description: "Birthdays coming up, and how old each person will be.",
  version: "1.0.0",
  permissions: ["ui", "data:read:contacts"],
  settings: {
    days: { type: "number", title: "Look ahead (days)", default: 60 },
  },
};

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The next time a yyyy-mm-dd birthday comes round, from today: { days, age, date }. */
export function next(birthday, today = new Date()) {
  const [year, month, day] = birthday.split("-").map(Number);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let when = new Date(start.getFullYear(), month - 1, day);
  if (when < start) when = new Date(start.getFullYear() + 1, month - 1, day);
  return { days: Math.round((when - start) / DAY), age: when.getFullYear() - year, date: `${day} ${MONTHS[month - 1]}` };
}

export default async function (ctx) {
  const views = ctx.ui.views("birthdays.html");

  views.live("side", "soon", async (ctx) => {
    const people = await ctx.call("data", "list", "contacts");
    const ahead = Number((await ctx.settings.get()).days ?? 60);
    const soon = people
      .filter((p) => p.birthday)
      .map((p) => ({ name: p.name, ...next(p.birthday) }))
      .filter((b) => b.days <= ahead)
      .sort((a, b) => a.days - b.days)
      .map((b) => ({ ...b, when: b.days === 0 ? "today" : b.days === 1 ? "tomorrow" : `in ${b.days} days`, tone: b.days <= 7 ? "warn" : "neutral" }));
    return { soon, ahead };
  });
}
