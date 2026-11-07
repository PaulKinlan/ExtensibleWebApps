// Due soon: a second plugin that reads the library without owning it. Its
// manifest asks for `data:read:library`, which lets it list the books and hear
// when they change. views.live draws the template in due-soon.html with what
// its function returns, and runs the function again after any write to the
// library, by any plugin.

export const manifest = {
  id: "due-soon",
  name: "Due soon",
  description: "Books due back in the next two weeks, or overdue.",
  version: "1.0.0",
  permissions: ["ui", "data:read:library"],
};

const DAY = 24 * 60 * 60 * 1000;

export default async function (ctx) {
  const views = ctx.ui.views("due-soon.html");

  views.live("side", "list", async (ctx) => {
    const books = await ctx.call("data", "list", "library");
    const today = new Date(new Date().toDateString()).getTime();
    const when = (days) => (days < 0 ? `${-days} days overdue` : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`);
    const due = books
      .filter((b) => b.due && b.shelf !== "done")
      .map((b) => ({ title: b.title, days: Math.round((new Date(`${b.due}T00:00:00`).getTime() - today) / DAY) }))
      .filter((b) => b.days <= 14)
      .sort((a, b) => a.days - b.days)
      .map((b) => ({ title: b.title, when: when(b.days), tone: b.days < 0 ? "danger" : b.days <= 3 ? "warn" : "neutral" }));
    return { books: due };
  });
}
