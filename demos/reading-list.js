// Reading list: a whole app with almost no code. The manifest declares a
// collection with a schema; the view is one string of HTML. <ui-form> builds
// its fields, labels and errors from the schema, <ui-table> lists the records
// and stays up to date, and the kernel checks every write against the schema.
// The plugin only handles what is specific to it: which book is open.

export const manifest = {
  id: "reading-list",
  name: "Reading list",
  description: "Books to read, built from a collection, ui-form and ui-table.",
  version: "1.0.0",
  permissions: ["ui"],
  collections: {
    library: {
      title: "Books",
      schema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", title: "Title" },
          author: { type: "string" },
          year: { type: "integer", minimum: 1450 },
          shelf: { type: "string", enum: ["to read", "reading", "done"], default: "to read" },
          due: { type: "string", format: "date", title: "Due back" },
          notes: { type: "string", "x-multiline": true },
        },
      },
    },
  },
};

const SAMPLE = [
  { title: "Dune", author: "Frank Herbert", year: 1965, shelf: "reading" },
  { title: "The Left Hand of Darkness", author: "Ursula K. Le Guin", year: 1969, shelf: "to read", due: "2026-11-21" },
  { title: "Piranesi", author: "Susanna Clarke", year: 2020, shelf: "done" },
];

export default async function (ctx) {
  const html = ctx.ui.html;
  // The plugin owns `library`, so it reads and writes it without asking.
  if (!(await ctx.call("data", "list", "library")).length) for (const book of SAMPLE) await ctx.call("data", "put", "library", book);

  let open = null; // the id of the book being edited, if any

  const draw = () =>
    ctx.ui.render(
      "app.main",
      "reading-list",
      html`
        <ui-toolbar><h2>Reading list</h2><ui-spacer></ui-spacer>${open ? html`<button data-action="close">Add a book instead</button>` : ""}</ui-toolbar>
        <ui-card>
          <h3>${open ? "Edit book" : "Add a book"}</h3>
          ${open
            ? html`<ui-form collection="library" record="${open}" submit="Save changes" action="saved"></ui-form>`
            : html`<ui-form collection="library" fields="title,author,year,shelf,due" submit="Add book"></ui-form>`}
        </ui-card>
        <ui-table collection="library" columns="title,author,year,shelf,due" sort="title" row-action="open" deletable empty="No books yet."></ui-table>`,
    );

  // Clicks in the view come back as actions; <ui-table>'s row-action sends the record id.
  ctx.ui.onEvent((action, value) => {
    if (action === "open") open = value;
    if (action === "close" || action === "saved") open = null;
    draw();
  });
  draw();
}
