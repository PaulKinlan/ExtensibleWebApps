// Pulse: how the board is doing, in the side column. It reads the cards
// (data:read:studio-cards) and draws live, so every move on the board shows here
// without this plugin listening for anything.
//
// The ring and the flow bar are sized by numbers in the data. A view's
// style attribute may set custom properties to numbers and nothing else, so
// the template writes style="--pct: {{pct}}" and pulse.html's CSS reads it:
// `calc(var(--pct) * 1%)`. A <meter> beside each says the same in words for
// screen readers.

export const manifest = {
  id: "pulse",
  name: "Pulse",
  description: "Progress, flow and who has what, from the board's cards.",
  version: "1.0.0",
  permissions: ["ui", "data:read:studio-cards"],
  order: 50,
};

const STAGES = [
  ["ideas", "Ideas"],
  ["next", "Up next"],
  ["doing", "In progress"],
  ["review", "Review"],
  ["done", "Shipped"],
];
const PEOPLE = ["Mei", "Kofi", "Ines", "Rafa", "Sam"];
/** Today as YYYY-MM-DD, by the local calendar, as the board and due.js count days. */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default async function (ctx) {
  const views = ctx.ui.views("pulse.html");
  const pulse = views.live("side", "pulse", async (api) => {
    const cards = await api.call("data", "list", "studio-cards");
    const points = (list) => list.reduce((sum, c) => sum + (c.points ?? 0), 0);
    const total = points(cards);
    const shipped = points(cards.filter((c) => c.column === "done"));
    const open = cards.filter((c) => c.column !== "done");
    const heaviest = Math.max(1, ...PEOPLE.map((p) => points(open.filter((c) => c.assignee === p))));
    return {
      pct: total ? Math.round((shipped / total) * 100) : 0,
      shipped,
      total,
      doing: cards.filter((c) => c.column === "doing").length,
      late: open.filter((c) => c.due && c.due < today()).length,
      lateTone: open.some((c) => c.due && c.due < today()) ? "danger" : "ok",
      count: cards.length,
      flow: STAGES.map(([id, title]) => ({ id, title, n: cards.filter((c) => c.column === id).length })),
      people: PEOPLE.map((name) => {
        const mine = open.filter((c) => c.assignee === name);
        return { name, initial: name[0], cards: mine.length, points: points(mine), max: heaviest };
      }),
    };
  });

  // "Overdue" depends on the date as well as the cards: draw again at each local midnight.
  const atMidnight = () => {
    const now = new Date();
    setTimeout(() => {
      pulse.refresh();
      atMidnight();
    }, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now + 1000);
  };
  atMidnight();
}
