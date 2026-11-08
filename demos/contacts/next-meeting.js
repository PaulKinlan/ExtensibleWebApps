// Next meeting: a view transform. The birthdays list is another plugin's
// view; this plugin adds a line to each person in it, with the next event in
// the calendar that names them. It needs the permission
// `ui:transform:birthdays`, which the person sees when it is installed, and
// its place says `in: "birthdays"`: the selector runs inside that plugin's
// views and nowhere else.
//
// The birthdays plugin draws again whenever a contact changes. Each time, the
// platform takes this plugin's additions off, lets the update happen, and
// puts them back; if the rows changed, "place:changed" says to look again.

export const manifest = {
  id: "next-meeting",
  name: "Next meeting",
  description: "Adds each person's next calendar event to the birthdays list.",
  version: "1.0.0",
  permissions: ["ui", "ui:transform:birthdays", "data:read:events"],
  places: {
    meeting: { in: "birthdays", at: "li[data-name]", put: "append", each: true },
  },
};

export default async function (ctx) {
  const html = ctx.ui.html;
  /** Today as the calendar writes dates: yyyy-mm-dd, in local time. Worked out on each draw, so it moves on at midnight. */
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const draw = async () => {
    const from = today();
    const rows = await ctx.call("page", "matches", "meeting");
    // The calendar's events, if the calendar app has been opened on this device.
    const events = await ctx.call("data", "list", "events").catch(() => []);
    rows.forEach(({ data }, i) => {
      const first = (data.name ?? "").split(" ")[0].toLowerCase();
      const next = events
        .filter((e) => e.date >= from && first && `${e.title} ${e.notes ?? ""}`.toLowerCase().includes(first))
        .sort((a, b) => (a.date + (a.start ?? "")).localeCompare(b.date + (b.start ?? "")))[0];
      ctx.ui.render(`meeting#${i}`, "next", next ? html`<small>Next: ${next.title}, ${next.date}${next.start ? ` at ${next.start}` : ""}</small>` : html`<small>No meeting planned</small>`);
    });
  };

  ctx.ui.onEvent((action) => {
    if (action === "place:changed") draw();
  });
  ctx.on("data:changed:events", () => draw());
  await draw();
}
