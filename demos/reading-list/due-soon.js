// Due soon: a second plugin that reads the library without owning it. Its
// manifest asks for `data:read:library`, to list the books, and
// `hook:listen:data:changed:library`, to hear every change to them. It draws
// in the app's side slot.

export const manifest = {
  id: "due-soon",
  name: "Due soon",
  description: "Books due back in the next two weeks, or overdue.",
  version: "1.0.0",
  permissions: ["ui", "data:read:library", "hook:listen:data:changed:library"],
};

const DAY = 24 * 60 * 60 * 1000;

export default async function (ctx) {
  const html = ctx.ui.html;

  const draw = async () => {
    const books = await ctx.call("data", "list", "library");
    const today = new Date(new Date().toDateString()).getTime();
    const due = books
      .filter((b) => b.due && b.shelf !== "done")
      .map((b) => ({ ...b, days: Math.round((new Date(`${b.due}T00:00:00`).getTime() - today) / DAY) }))
      .filter((b) => b.days <= 14)
      .sort((a, b) => a.days - b.days);
    const when = (days) => (days < 0 ? `${-days} days overdue` : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`);

    ctx.ui.render(
      "side",
      "due-soon",
      html`
        <h3>Due back soon</h3>
        ${due.length
          ? html`<ul>${due.map((b) => html`<li><strong>${b.title}</strong> <ui-badge tone="${b.days < 0 ? "danger" : b.days <= 3 ? "warn" : "neutral"}">${when(b.days)}</ui-badge></li>`)}</ul>`
          : html`<p><small>Nothing due in the next two weeks.</small></p>`}`,
    );
  };

  // Any write to the library, by any plugin, redraws the list.
  ctx.on("data:changed:library", () => draw());
  draw();
}
