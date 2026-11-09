// Import and Export for every collection in the app: save one to a CSV or
// JSON file, or bring a file's rows into one (a bank's statement into the
// expenses, a spreadsheet into the reading list).
//
// Add it to any app with two lines in its app.html:
//
//   <link rel="plugin" href="/std/import-export.js">
//   <slot name="import-export"></slot>
//
// The kernel does the work (std/transfer/module.ts): it reads the
// file's columns into the collection's fields and asks the person to review
// the import once, as a whole. This plugin only draws the buttons and says
// what happened. It needs the `transfer` permission, and runs in each tab
// (scope "tab") so the file chooser and the download open in the tab that
// was clicked.

export const manifest = {
  id: "import-export",
  name: "Import and export",
  description: "Buttons to save each of the app's collections to a CSV or JSON file, and to import a file's rows into one.",
  version: "1.0.0",
  scope: "tab",
  permissions: ["ui", "transfer"],
  services: ["transfer"],
  // Where it draws on a page with no <slot name="import-export">, such as a person adding it to any app from the
  // registry (packages/std.json); a page with the slot keeps it there.
  places: { "import-export": { at: "main", put: "append" } },
  // Copied with it when a person adds it to an app.
  files: ["import-export.html"],
};

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What an import did, in a sentence or two. */
function summary(title, r) {
  if (!r.ok) return r.cancelled ? "" : r.error;
  const done = [r.added && `Added ${plural(r.added, "record")}`, r.replaced && `replaced ${plural(r.replaced, "record")}`].filter(Boolean).join(" and ");
  const parts = [`${done || "Nothing changed"} in ${title} from ${r.file}.`];
  if (r.skipped.length) parts.push(`Skipped ${r.skipped.slice(0, 3).map((s) => `row ${s.row} (${s.error})`).join(", ")}${r.skipped.length > 3 ? ` and ${r.skipped.length - 3} more` : ""}.`);
  if (r.ignored.length) parts.push(`Left out the column${r.ignored.length === 1 ? "" : "s"} ${r.ignored.join(", ")}.`);
  return parts.join(" ");
}

export default async function (ctx) {
  const views = ctx.ui.views("import-export.html");
  /** What the last press did, shown until the next one. */
  let message = "";
  let busy = false;

  const panel = views.live("import-export", "panel", async (ctx) => {
    const collections = await ctx.call("transfer", "collections");
    return {
      collections: collections.map((c) => ({ ...c, count: plural(c.count, "record") })),
      none: !collections.length,
      message,
      busy,
    };
  });

  // The counts change with the data (transfer:changed). Many writes at once (an import) redraw once, just after the last.
  let soon;
  const later = () => {
    clearTimeout(soon);
    soon = setTimeout(() => panel.refresh(), 100);
  };
  ctx.on("transfer:changed", later);

  ctx.ui.onEvent(async (action, name) => {
    const [verb, format] = String(action).split(":");
    if (verb !== "import" && verb !== "export") return;
    const title = (await ctx.call("transfer", "collections")).find((c) => c.name === name)?.title ?? name;
    busy = true;
    message = verb === "import" ? `Importing into ${title}…` : "";
    panel.refresh();
    try {
      if (verb === "export") {
        const r = await ctx.call("transfer", "export", name, format);
        message = `Saved ${plural(r.count, "record")} from ${title} to ${r.file}.`;
      } else {
        message = summary(title, await ctx.call("transfer", "import", name));
      }
    } catch (error) {
      message = String(error?.message ?? error);
    }
    busy = false;
    panel.refresh();
  });
}
