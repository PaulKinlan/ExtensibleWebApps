// People: the plugin that owns the contacts. Like the reading list's
// library, the form and table come from the collection's schema; this plugin
// adds a search box. Typing in it (data-live) sends "search" after a pause,
// and the plugin draws the matching people with its own template, since a
// bound <ui-table> always shows the whole collection.

export const manifest = {
  id: "people",
  name: "People",
  description: "Everyone you know, with a form to add or edit a person and a table of them all.",
  version: "1.0.0",
  permissions: ["ui"],
  order: 10,
  collections: {
    contacts: {
      title: "Contacts",
      schema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", title: "Name", maxLength: 120 },
          email: { type: "string", format: "email" },
          phone: { type: "string", maxLength: 40 },
          birthday: { type: "string", format: "date" },
          company: { type: "string" },
          notes: { type: "string", "x-multiline": true },
        },
      },
    },
  },
};

/** A birthday this many days from today, in the given year. */
const birthday = (year, days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${year}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Birthdays near today, so the birthdays list (and the calendar) have something to show.
const SAMPLE = [
  { name: "Priya Shah", email: "priya@example.com", birthday: birthday(1990, 3), company: "Northwind" },
  { name: "Sam Rivera", email: "sam@example.com", phone: "+44 20 7946 0000", birthday: birthday(1985, 20) },
  { name: "Jo Okafor", email: "jo@example.com", birthday: birthday(1978, 120), company: "Tailspin Toys" },
];

export default async function (ctx) {
  const views = ctx.ui.views("people.html");
  if (!(await ctx.storage.get("seeded"))) {
    for (const person of SAMPLE) await ctx.call("data", "put", "contacts", person);
    await ctx.storage.set("seeded", true);
  }

  let open = null; // the id of the person being edited, if any
  let search = ""; // what's in the search box

  const draw = async () => {
    // With a search, list the matches; without one, the bound table shows everyone.
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = words.length
      ? (await ctx.call("data", "list", "contacts"))
          .filter((p) => words.every((w) => [p.name, p.email, p.company, p.phone].some((f) => f?.toLowerCase().includes(w))))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];
    views.render("main", "people", { open, search, searching: words.length > 0, matches });
  };

  ctx.ui.onEvent((action, value) => {
    if (action === "open") open = value;
    if (action === "close" || action === "saved") open = null;
    if (action === "search") search = String(value ?? "");
    draw();
  });
  ctx.on("data:changed:contacts", (change) => {
    if (change.id === open && !change.after) open = null;
    draw();
  });
  draw();
}
