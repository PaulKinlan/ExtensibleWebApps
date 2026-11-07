// Book import: adds books from a pasted list, one per line, as
// "Title by Author". It may write to the library (`data:write:library`), but
// the library belongs to another plugin, so the kernel shows the person each
// change first and nothing is written unless they allow it.

export const manifest = {
  id: "book-import",
  name: "Book import",
  description: "Paste a list of books to add them to the library.",
  version: "1.0.0",
  permissions: ["ui", "data:write:library"],
  order: 20,
};

export default async function (ctx) {
  const views = ctx.ui.views("book-import.html");
  let status = "";
  const draw = () => views.render("side", "form", { status });

  ctx.ui.onEvent(async (action, value) => {
    if (action !== "import") return;
    const books = String(value.list ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [title, author] = line.split(/\s+by\s+/i);
        return author ? { title, author } : { title };
      });
    let added = 0;
    for (const book of books) {
      // Each write waits for the person's answer to the review card.
      const result = await ctx.call("data", "put", "library", book, `Import “${book.title}” from a pasted list`).catch((error) => ({ ok: false, error: error.message }));
      if (result.ok) added++;
    }
    status = `Added ${added} of ${books.length}.`;
    draw();
  });
  draw();
}
