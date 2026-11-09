// Chores: owns the `chores` collection, what needs doing and how often.
// "Done" stamps a chore with today's date and who did it, so everyone sees
// whose turn it was last; the list puts what's overdue first. In a space
// "who" is the member's id, shown as the name on their account (see
// housemates.js).
//
// In a space the chores sync like any collection. Two people marking the
// same chore done while apart is a conflict the space settles: the first
// change it hears is kept, and the other is a draft on the phone that made it.

export const manifest = {
  id: "chores",
  name: "Chores",
  description: "What needs doing around the house, how often, and who did it last.",
  version: "1.0.0",
  permissions: ["ui", "members", "hook:listen:members:changed", "bus:read:household-new", "hook:listen:bus:posted"],
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

const capital = (words) => words.charAt(0).toUpperCase() + words.slice(1);

const ago = (date) => {
  const days = -daysTo(date);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};

/**
 * Who is using this device, and everyone's names: in a space, the space's members (sync.members), so a
 * stamp is a member's id and shows as the name on their account. On its own there's one person, "me".
 */
async function people(ctx) {
  const { space, you, members } = await ctx.call("sync", "members");
  if (!space) return { me: "me", name: () => "you" };
  const names = Object.fromEntries(members.map((m) => [m.id, m.name]));
  // Someone who has left the space, or a stamp from before names came from accounts, is "someone".
  return { me: you ?? "", name: (id) => (id === you ? "you" : names[id] ?? "someone") };
}

/**
 * Whether to add the sample items: only in a new household (housemates.js says, on the bus topic
 * `household-new`), with nothing in the collection yet. This plugin's own `seeded` flag, which stays on
 * the device, keeps it from adding them twice.
 */
async function seedOnce(ctx, collection, samples) {
  if (await ctx.storage.get("seeded")) return;
  const posts = await ctx.call("bus", "read", "household-new");
  if (!posts.length) return;
  let fresh = false;
  try {
    fresh = JSON.parse(posts[posts.length - 1].text)?.new === true;
  } catch {}
  await ctx.storage.set("seeded", true);
  if (fresh && !(await ctx.call("data", "list", collection)).length) for (const sample of samples) await ctx.call("data", "put", collection, sample);
}

export default async function (ctx) {
  const views = ctx.ui.views("chores.html");
  // Listening comes first: housemates.js may post while this plugin is still reading what was posted before,
  // and a post missed then would leave a new household with no samples. One at a time, so they go in once.
  let seeding = Promise.resolve();
  const seed = () => (seeding = seeding.then(() => seedOnce(ctx, "chores", SAMPLE)).catch(() => {}));
  ctx.on("bus:posted", ({ topic }) => topic === "household-new" && seed());
  await seed();
  let added = 0;

  const view = views.live("chores", "list", async (ctx) => {
    const { name } = await people(ctx);
    const who = (id) => (id ? name(id) : "someone");
    const chores = (await ctx.call("data", "list", "chores"))
      .map((c) => ({ chore: c, due: due(c) }))
      .sort((a, b) => a.due.order - b.due.order || a.chore.name.localeCompare(b.chore.name))
      .map(({ chore: c, due: d }) => ({
        id: c.id,
        name: c.name,
        often: OFTEN[c.every] ?? `every ${c.every} days`,
        when: d.when,
        tone: d.tone,
        last: c.doneOn ? `${capital(who(c.doneBy))} did it ${ago(c.doneOn)}` : "",
        today: c.doneOn === iso(new Date()),
      }));
    return { chores, form: `add-${added}` };
  });

  ctx.on("members:changed", () => view.refresh());
  // "Due today" becomes "1 day overdue" at midnight, with no change to any chore: draw again then.
  const atMidnight = () => {
    const now = new Date();
    setTimeout(() => (view.refresh(), atMidnight()), new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() + 1000);
  };
  atMidnight();

  ctx.ui.onEvent(async (action, value) => {
    const { me } = await people(ctx);
    if (action.startsWith("done:")) {
      const chore = await ctx.call("data", "get", "chores", action.slice(5));
      if (!chore) return;
      const { doneBy, ...rest } = chore;
      await ctx.call("data", "put", "chores", { ...rest, doneOn: iso(new Date()), ...(me ? { doneBy: me } : {}) });
    }
    if (action === "add" && value.name?.trim()) {
      const saved = await ctx.call("data", "put", "chores", { name: value.name.trim(), every: Number(value.every) || 7 });
      // A refused add (a data:beforeWrite listener blocked it, say) keeps what was typed.
      if (!saved.ok) return;
      added++;
      view.refresh();
    }
    if (action.startsWith("remove:")) await ctx.call("data", "delete", "chores", action.slice(7));
  });
}
