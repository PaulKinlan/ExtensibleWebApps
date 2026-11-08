// Chores: owns the `chores` collection, what needs doing and how often.
// "Done" stamps a chore with today's date and who did it, so everyone sees
// whose turn it was last; the list puts what's overdue first. Who "I" am
// comes from the bus topic `household-me` (see housemates.js).
//
// In a space the chores sync like any collection. Two people marking the
// same chore done while apart is a conflict the space settles: the first
// change it hears is kept, and the other is a draft on the phone that made it.

export const manifest = {
  id: "chores",
  name: "Chores",
  description: "What needs doing around the house, how often, and who did it last.",
  version: "1.0.0",
  permissions: ["ui", "bus:read:household-me", "data:read:housemates", "hook:listen:bus:posted"],
  collections: {
    chores: {
      title: "Chores",
      schema: {
        type: "object",
        required: ["name", "every"],
        properties: {
          name: { type: "string", title: "Chore", maxLength: 80 },
          every: { type: "integer", title: "Every (days)", minimum: 1, maximum: 365 },
          doneOn: { type: "string", title: "Last done", format: "date" },
          doneBy: { type: "string", title: "Done by", maxLength: 40 },
        },
      },
    },
  },
};

const SAMPLE = [
  { id: "sample-bins", name: "Put the bins out", every: 7 },
  { id: "sample-plants", name: "Water the plants", every: 3 },
];
const OFTEN = { 1: "daily", 7: "weekly", 14: "fortnightly", 30: "monthly" };

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DAY = 86_400_000;
/** Whole days from today to `date` ("2026-11-08"): negative in the past. */
const daysTo = (date, today = new Date()) => Math.round((new Date(`${date}T12:00`).getTime() - new Date(`${iso(today)}T12:00`).getTime()) / DAY);

/** When a chore is next due, in words, with a badge tone and a number to sort by. */
export function due(chore, today = new Date()) {
  if (!chore.doneOn) return { when: "Not done yet", tone: "warn", order: -Infinity };
  const next = new Date(`${chore.doneOn}T12:00`);
  next.setDate(next.getDate() + chore.every);
  const days = daysTo(iso(next), today);
  if (days < 0) return { when: `${-days} ${days === -1 ? "day" : "days"} overdue`, tone: "danger", order: days };
  if (days === 0) return { when: "Due today", tone: "warn", order: 0 };
  return { when: days === 1 ? "Due tomorrow" : `Due in ${days} days`, tone: days <= 2 ? "accent" : "neutral", order: days };
}

const ago = (date) => {
  const days = -daysTo(date);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};

async function myName(ctx) {
  const posts = await ctx.call("bus", "read", "household-me");
  try {
    return (posts.length && JSON.parse(posts[posts.length - 1].text)?.name) || "";
  } catch {
    return "";
  }
}

/**
 * Whether to add the sample items: only for a household nobody has joined yet, with nothing in the
 * collection. Both are synced, so a phone new to a space where people have cleared everything
 * doesn't put the samples back; this plugin's own `seeded` flag, which stays on the device, keeps
 * this device from adding them twice.
 */
async function newHousehold(ctx, collection) {
  return !(await ctx.call("data", "list", collection)).length && !(await ctx.call("data", "list", "housemates")).length;
}

export default async function (ctx) {
  const views = ctx.ui.views("chores.html");
  if (!(await ctx.storage.get("seeded"))) {
    if (await newHousehold(ctx, "chores")) for (const chore of SAMPLE) await ctx.call("data", "put", "chores", chore);
    await ctx.storage.set("seeded", true);
  }
  let added = 0;

  const view = views.live("chores", "list", async (ctx) => {
    const me = await myName(ctx);
    const chores = (await ctx.call("data", "list", "chores"))
      .map((c) => ({ chore: c, due: due(c) }))
      .sort((a, b) => a.due.order - b.due.order || a.chore.name.localeCompare(b.chore.name))
      .map(({ chore: c, due: d }) => ({
        id: c.id,
        name: c.name,
        often: OFTEN[c.every] ?? `every ${c.every} days`,
        when: d.when,
        tone: d.tone,
        last: c.doneOn ? `${c.doneBy ? (c.doneBy === me ? "You" : c.doneBy) : "Someone"} did it ${ago(c.doneOn)}` : "",
        today: c.doneOn === iso(new Date()),
      }));
    return { chores, form: `add-${added}` };
  });

  ctx.on("bus:posted", ({ topic }) => topic === "household-me" && view.refresh());
  // "Due today" becomes "1 day overdue" at midnight, with no change to any chore: draw again then.
  const atMidnight = () => {
    const now = new Date();
    setTimeout(() => (view.refresh(), atMidnight()), new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() + 1000);
  };
  atMidnight();

  ctx.ui.onEvent(async (action, value) => {
    const me = await myName(ctx);
    if (action.startsWith("done:")) {
      const chore = await ctx.call("data", "get", "chores", action.slice(5));
      if (!chore) return;
      const { doneBy, ...rest } = chore;
      await ctx.call("data", "put", "chores", { ...rest, doneOn: iso(new Date()), ...(me ? { doneBy: me } : {}) });
    }
    if (action === "add" && value.name?.trim()) {
      await ctx.call("data", "put", "chores", { name: value.name.trim(), every: Number(value.every) || 7 });
      added++;
      view.refresh();
    }
    if (action.startsWith("remove:")) await ctx.call("data", "delete", "chores", action.slice(7));
  });
}
