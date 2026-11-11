// Reminders: on the space's server only, it tells the household when a chore
// comes due, with the app closed on every phone. A chore done on the 1st and
// due weekly is due again on the 8th; at eight that morning everyone who
// turned notifications on (on their account page, once for each device) gets
// "Put the bins out is due". One notification for each time a chore comes
// due, and one for several that come due together.
//
// Nothing polls. The plugin works out the next moment any chore comes due
// and sets one job for then (ctx.schedule.at), again whenever the chores
// change, so the space sleeps in between. "Eight in the morning" is in the
// time zone of whoever last added the chore or marked it done (chores.js
// stamps it), since a server has no morning of its own.
//
// What it has already said is kept in a collection of its own, so a restart
// doesn't say it twice. Only the space's owner and this plugin may change it
// (`rules`), so nobody's phone can silence the others' reminders.
//
// Outside a space there is no server, and the list on the page says what's due.

export const manifest = {
  id: "reminders",
  name: "Chore reminders",
  description: "Tells everyone when a chore comes due, even with the app closed.",
  version: "1.0.0",
  runs: "server",
  permissions: ["notify", "schedule", "data:read:chores", "hook:listen:data:changed:chores"],
  collections: {
    "chore-reminders": {
      title: "Chore reminders sent",
      schema: { type: "object", required: ["due"], properties: { due: { type: "string", title: "Due date told about", format: "date" } } },
      rules: { add: "owner", change: "owner", remove: "owner" },
    },
  },
};

/** The hour of the morning a reminder is sent, where the chore's people are. */
const HOUR = 8;
const DAY = 86_400_000;

/** The date `days` after one ("2026-11-01" and 7 give "2026-11-08"). */
const plus = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** Eight in the morning of a date in a time zone, as a moment. A zone that isn't one counts as UTC. */
export function morning(date, zone) {
  const guess = Date.parse(`${date}T${String(HOUR).padStart(2, "0")}:00:00Z`);
  try {
    // What the clocks in the zone say at that moment, read as if it were UTC: the difference is the zone's offset.
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess).map((p) => [p.type, p.value]));
    return guess - (Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - guess);
  } catch {
    return guess;
  }
}

/**
 * What to do now: the chores that have come due and nobody has been told about (`told` is chore id to the due
 * date last told), and the next moment one comes due. A chore never done has no due date to speak of.
 */
export function plan(chores, told, now) {
  const tell = [];
  let next;
  for (const chore of chores) {
    if (!chore.doneOn || !/^\d{4}-\d\d-\d\d$/.test(chore.doneOn) || !(chore.every >= 1)) continue;
    const due = plus(chore.doneOn, chore.every);
    const at = morning(due, chore.zone);
    if (at > now) next = Math.min(next ?? at, at);
    else if (told[chore.id] !== due) tell.push({ id: chore.id, name: chore.name, due });
  }
  return { tell, next };
}

/** What the notification says, for one chore or several. */
export function wording(tell) {
  if (tell.length === 1) return { title: `${tell[0].name} is due`, body: "Mark it done in Household once it is." };
  return { title: `${tell.length} chores are due`, body: tell.map((t) => t.name).join(", ") };
}

export default async function (ctx) {
  // One look at a time: a change heard while a notification is being sent waits for it, so nothing is said twice.
  let looking = Promise.resolve();
  const look = () =>
    (looking = looking
      .then(async () => {
        const chores = await ctx.call("data", "list", "chores");
        const kept = await ctx.call("data", "list", "chore-reminders");
        const { tell, next } = plan(chores, Object.fromEntries(kept.map((k) => [k.id, k.due])), Date.now());
        // A chore that was removed needs no record of what was said about it.
        for (const k of kept) if (!chores.some((c) => c.id === k.id)) await ctx.call("data", "delete", "chore-reminders", k.id);
        if (tell.length) {
          // Kept before sending: a reminder missed is better than one that repeats every time the space starts.
          for (const t of tell) await ctx.call("data", "put", "chore-reminders", { id: t.id, due: t.due });
          await ctx.call("notify", "show", { ...wording(tell), tag: "due" });
        }
        if (next) await ctx.schedule.at("due", next, look);
        else await ctx.schedule.cancel("due").catch(() => {});
      })
      .catch((error) => ctx.log(`Couldn't look for chores that are due: ${error?.message ?? error}`)));

  ctx.on("data:changed:chores", look);
  await look();
}
