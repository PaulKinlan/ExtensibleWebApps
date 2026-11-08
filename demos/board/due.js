// Due dates: a badge on every card that has one, in the room the board
// leaves on each card (<slot name="board.card.badges">). It needs no data
// permission at all: the board puts each card's due date and stage on the
// slot as data-due and data-column, and page.slots hands them over. So this
// plugin can say "Due tomorrow" without being able to read a single card.
//
// When the board draws again (a card moves, a date changes), the slots
// change and this plugin hears "slot:changed", asks again and redraws. It
// also redraws at midnight, when "tomorrow" becomes "today".

export const manifest = {
  id: "due",
  name: "Due dates",
  description: "How soon each card is due, as a badge on the card.",
  version: "1.0.0",
  permissions: ["ui"],
  // The board is drawn per tab (each tab may show another screen), so this asks its own tab's slots.
  scope: "tab",
  order: 20,
};

const SLOT = "board.card.badges";
const DAY = 86_400_000;

/** How a due date reads, and how loud it should be: { text, tone } or null. */
export function when(due, done, today = new Date()) {
  if (!due) return null;
  const start = new Date(today.toDateString()).getTime();
  const days = Math.round((new Date(`${due}T00:00:00`).getTime() - start) / DAY);
  if (done) return { text: new Date(`${due}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" }), tone: "calm" };
  if (days < -1) return { text: `${-days} days late`, tone: "late" };
  if (days === -1) return { text: "Due yesterday", tone: "late" };
  if (days === 0) return { text: "Due today", tone: "soon" };
  if (days === 1) return { text: "Tomorrow", tone: "soon" };
  if (days < 7) return { text: `In ${days} days`, tone: "near" };
  return { text: new Date(`${due}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" }), tone: "calm" };
}

export default async function (ctx) {
  const views = ctx.ui.views("due.html");

  const fill = async () => {
    const slots = await ctx.call("page", "slots", SLOT);
    slots.forEach(({ data }, i) => {
      const due = when(data.due, data.column === "done");
      // Rendering null takes this plugin's badge out of that card's room.
      if (!due) return ctx.ui.render(`${SLOT}#${i}`, "due", null);
      views.render(`${SLOT}#${i}`, "due", { ...due, date: data.due });
    });
  };

  ctx.ui.onEvent((action) => {
    if (action === "slot:changed") fill();
  });
  await fill();

  // At the next midnight, and every day after, the words change.
  const midnight = new Date(new Date().toDateString()).getTime() + DAY - Date.now();
  setTimeout(() => {
    fill();
    setInterval(fill, DAY);
  }, midnight + 1000);
}
