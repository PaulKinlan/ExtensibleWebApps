// Checklist: steps for a card, kept in a collection this plugin owns. It
// draws in two rooms the board leaves for it, and never touches the board's
// own view:
//
//   studio.card.badges  a small "2/5" on each card that has steps
//   studio.card.detail  the whole checklist on the card's own screen, with a
//                      progress bar, a tick per step and a field to add one
//
// A step is { card, text, done, rank }; `card` is the card's id, which the
// board puts on each slot as data-id. Switching this plugin off takes the
// badges and the list away, and the board doesn't notice.

export const manifest = {
  id: "checklist",
  name: "Checklist",
  description: "Steps for each card: a count on the board, and a checklist on the card's screen.",
  version: "1.0.0",
  permissions: ["ui"],
  scope: "tab",
  order: 30,
  collections: {
    steps: {
      title: "Checklist steps",
      schema: {
        type: "object",
        required: ["card", "text"],
        properties: {
          card: { type: "string", title: "Card" },
          text: { type: "string", title: "Step", maxLength: 200 },
          done: { type: "boolean", title: "Done" },
          rank: { type: "number" },
        },
      },
    },
  },
};

const BADGES = "studio.card.badges";
const DETAIL = "studio.card.detail";

// Steps for the board's sample cards (board.js gives them fixed ids).
const SAMPLE = [
  ["card-icons", "Sketch all five", true],
  ["card-icons", "Motion pass in the prototype", true],
  ["card-icons", "Reduced-motion stills", false],
  ["card-icons", "Export and hand over", false],
  ["card-offline", "Cache the last six radar frames", false],
  ["card-offline", "Show how old the map is", false],
  ["card-offline", "Test in airplane mode", false],
  ["card-rotate", "Reproduce on a small phone", true],
  ["card-rotate", "Keep scroll position across rotation", true],
  ["card-rotate", "Regression test", false],
  ["card-widget", "Small and medium sizes", true],
  ["card-widget", "Lock screen glyphs", true],
];

export default async function (ctx) {
  const views = ctx.ui.views("checklist.html");

  if (!(await ctx.storage.get("seeded"))) {
    if (!(await ctx.call("data", "list", "steps")).length) {
      for (const [i, [card, text, done]] of SAMPLE.entries()) await ctx.call("data", "put", "steps", { id: `step-${i}`, card, text, done, rank: i });
    }
    await ctx.storage.set("seeded", true);
  }

  /** Each card's steps, in order: Map(card id → [step]). */
  const byCard = async () => {
    const map = new Map();
    for (const s of (await ctx.call("data", "list", "steps")).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))) {
      if (!map.has(s.card)) map.set(s.card, []);
      map.get(s.card).push(s);
    }
    return map;
  };

  const fill = async () => {
    const steps = await byCard();
    const badges = await ctx.call("page", "slots", BADGES);
    badges.forEach(({ data }, i) => {
      const list = steps.get(data.id) ?? [];
      const done = list.filter((s) => s.done).length;
      if (!list.length) return ctx.ui.render(`${BADGES}#${i}`, "count", null);
      views.render(`${BADGES}#${i}`, "count", { done, total: list.length, all: done === list.length });
    });
    const details = await ctx.call("page", "slots", DETAIL);
    details.forEach(({ data }, i) => {
      const list = steps.get(data.id) ?? [];
      const done = list.filter((s) => s.done).length;
      views.render(`${DETAIL}#${i}`, "steps", {
        card: data.id,
        steps: list,
        done,
        total: list.length,
        all: list.length > 0 && done === list.length,
      });
    });
  };

  ctx.ui.onEvent(async (action, value) => {
    if (action === "slot:changed") return void fill();
    const [verb, arg] = action.split(":");
    if (verb === "tick") {
      const step = await ctx.call("data", "get", "steps", arg);
      if (step) await ctx.call("data", "put", "steps", { ...step, done: value });
    }
    if (verb === "add") {
      const text = String(value?.text ?? "").trim();
      if (!text) return;
      const rank = Math.max(0, ...[...((await byCard()).get(arg) ?? [])].map((s) => s.rank ?? 0)) + 1;
      await ctx.call("data", "put", "steps", { card: arg, text, done: false, rank });
    }
    if (verb === "remove") await ctx.call("data", "delete", "steps", arg);
  });
  ctx.on("data:changed:steps", fill);
  await fill();
}
