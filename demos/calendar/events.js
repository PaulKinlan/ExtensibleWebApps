// Events: the plugin that owns the calendar's events. Its view is the add
// form and a table of every event, both built from the schema. month.js and
// agenda.js only read the events.

export const manifest = {
  id: "events",
  name: "Events",
  description: "Add, edit and delete events.",
  version: "1.0.0",
  permissions: ["ui"],
  order: 20,
  collections: {
    events: {
      title: "Events",
      schema: {
        type: "object",
        required: ["title", "date"],
        properties: {
          title: { type: "string", title: "What", maxLength: 120 },
          date: { type: "string", format: "date", title: "Date" },
          start: { type: "string", title: "Starts", description: "A time such as 09:30", maxLength: 5 },
          where: { type: "string", title: "Where" },
          notes: { type: "string", "x-multiline": true },
        },
      },
    },
  },
};

/** yyyy-mm-dd for a day this many days from today. */
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default async function (ctx) {
  const views = ctx.ui.views("events.html");
  if (!(await ctx.storage.get("seeded"))) {
    // Samples near today, so the month and the agenda have something to show.
    for (const event of [
      { title: "Team lunch", date: day(1), start: "12:30", where: "The Canteen" },
      { title: "Dentist", date: day(4), start: "09:00" },
      { title: "Book club", date: day(9), start: "19:00", where: "Library" },
    ]) await ctx.call("data", "put", "events", event);
    await ctx.storage.set("seeded", true);
  }

  let open = null;
  const draw = () => views.render("main", "events", { open });
  ctx.ui.onEvent((action, value) => {
    if (action === "open") open = value;
    if (action === "close" || action === "saved") open = null;
    draw();
  });
  ctx.on("data:changed:events", (change) => {
    if (change.id === open && !change.after) {
      open = null;
      draw();
    }
  });
  draw();
}
