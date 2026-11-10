// Tidies the open note and exports it as Markdown. Both are writes outside
// this plugin's own data (the note is in the notes plugin's collection; the
// file is in the data folder), so the person reviews a diff before either
// happens. Its own counts live in its own storage, which needs no review.

export const manifest = {
  id: "tidy",
  name: "Tidy",
  description: "Tidies the open note's spacing and exports it as Markdown, to show change review.",
  version: "1.0.0",
  permissions: ["ui", "hook:listen:notes:open", "hook:listen:notes:save", "hook:listen:notes:close", "data:write:notes", "files:exports"],
  order: 25,
};

/** Trailing spaces off every line; no more than one blank line in a row; no blank lines at the end. */
const tidyText = (text) => text.split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "note";

export default async function (ctx) {
  let note = null;
  let status = "";
  const counts = (await ctx.storage.get("counts")) ?? { tidied: 0, exported: 0 };

  // An HTML view: plain HTML with the host's components, values escaped by ctx.ui.html.
  const draw = (api = ctx) => {
    const html = api.ui.html;
    const failed = status.startsWith("Not") || status.startsWith("The person");
    api.ui.render(
      "side",
      "tidy",
      html`<h3>Tidy</h3>
        ${note
          ? html`<ui-toolbar><button data-action="tidy">Tidy this note</button><button data-action="export">Export as Markdown</button></ui-toolbar>`
          : html`<p><small>Open a note to tidy or export it.</small></p>`}
        ${status ? html`<p role="status"><ui-badge tone="${failed ? "danger" : "neutral"}">${status}</ui-badge></p>` : ""}
        <p><small>Tidied ${counts.tidied} · exported ${counts.exported}</small></p>`,
    );
  };

  const track = (snapshot) => {
    note = snapshot;
    draw();
  };
  // The notes plugin's own hooks: notes:<key>.
  ctx.on("notes:open", (snapshot) => {
    status = "";
    track(snapshot);
  });
  ctx.on("notes:save", track);
  ctx.on("notes:close", () => track(null));

  ctx.ui.onEvent(async (action) => {
    if (!note || (action !== "tidy" && action !== "export")) return;
    const here = ctx.traced();
    try {
      if (action === "tidy") {
        const text = tidyText(note.text);
        if (text === note.text) {
          status = "Already tidy";
        } else {
          // The person may open another note while the review is open; remember which one this is.
          const { id, title } = note;
          const result = await here.call("data", "put", "notes", { id, title, text }, "Trim trailing spaces and extra blank lines");
          if (!result.ok) throw new Error(`Not saved: ${result.error ?? (result.errors ?? []).join(", ")}`);
          if (note?.id === id) note = { ...note, text };
          counts.tidied++;
          status = `Tidied (${result.outcome})`;
        }
      } else {
        const path = `exports/${slug(note.title)}.md`;
        const result = await here.call("files", "write", path, note.text, "Export the note as Markdown");
        counts.exported++;
        status = result.unchanged ? `${path} is already up to date` : `Exported to ${path} (${result.outcome})`;
      }
      await here.storage.set("counts", counts);
    } catch (error) {
      status = error.message;
    }
    here.log(`tidy: ${status}`);
    draw(here);
  });

  draw();
}
