// Work-in-progress limits: a transform. The board never planned for limits,
// but each column's header says which column it is and how many cards it
// holds (data-column, data-count). This plugin names that header as a
// place inside the board's view, `in: "board"`, and adds a small gauge to
// each one: "2 of 3", or a warning once a column is over its limit.
//
// Changing another plugin's view takes the permission ui:transform:board,
// which the person sees in the plugins panel. The limit and the columns it
// applies to are settings, so the panel draws a form for them.

export const manifest = {
  id: "wip",
  name: "Work-in-progress limits",
  description: "A limit on how many cards each busy column holds, shown in its header.",
  version: "1.0.0",
  permissions: ["ui", "ui:transform:board"],
  scope: "tab",
  order: 40,
  places: {
    gauge: { in: "board", at: ".column-head", put: "append", each: true },
  },
  settings: {
    limit: { type: "number", title: "Cards per column", default: 3 },
    columns: { type: "string", title: "Columns it applies to", description: "Their ids, with commas: ideas, next, doing, review, done", default: "doing, review" },
  },
};

export default async function (ctx) {
  const views = ctx.ui.views("wip.html");
  let settings = await ctx.settings.get();

  const draw = async () => {
    const limited = new Set(String(settings.columns).split(",").map((s) => s.trim()));
    const limit = Math.max(1, Number(settings.limit) || 3);
    const heads = await ctx.call("page", "matches", "gauge");
    heads.forEach(({ data }, i) => {
      if (!limited.has(data.column)) return ctx.ui.render(`gauge#${i}`, "gauge", null);
      const count = Number(data.count) || 0;
      views.render(`gauge#${i}`, "gauge", { count, limit, over: count > limit, full: count === limit, by: count - limit });
    });
  };

  ctx.settings.onChange((next) => {
    settings = next;
    draw();
  });
  ctx.ui.onEvent((action) => {
    if (action === "place:changed") draw();
  });
  await draw();
}
