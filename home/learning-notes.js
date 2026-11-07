// Learning notes: the playground every chapter acts on. Write down what you
// notice as you go; the notes are kept in this browser, so they're still
// here when you come back.
//
// This plugin owns the `learning` collection, so it reads and writes it
// freely. Other plugins on the page can read it if they ask (note-stats.js),
// or stop a write before it lands (quiet-please.js), but this plugin never
// calls them, and they never call it.

export const manifest = {
  id: "learning-notes",
  name: "Learning notes",
  description: "Your notes as you learn how the page works, kept in this browser.",
  version: "1.0.0",
  permissions: ["ui"],
  collections: {
    learning: {
      title: "Learning notes",
      schema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", title: "Note", minLength: 1, maxLength: 2000, "x-multiline": true },
        },
      },
    },
  },
};

export default async function (ctx) {
  const views = ctx.ui.views("learning-notes.html");
  /** Why the last note wasn't saved, shown until the next try. */
  let problem = "";

  const notes = views.live("playground", "notes", async (ctx) => {
    const all = await ctx.call("data", "list", "learning");
    return {
      problem,
      notes: all.map((n) => ({ id: n.id, text: n.text, when: new Date(n.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) })),
    };
  }, { order: 10 });

  ctx.ui.onEvent(async (action, value) => {
    if (action === "add") {
      const text = String(value?.text ?? "").trim();
      if (!text) return;
      const result = await ctx.call("data", "put", "learning", { text }).catch((e) => ({ ok: false, error: e.message }));
      // A plugin listening on data:beforeWrite:learning may have stopped it; say why.
      problem = result.ok ? "" : result.error ?? (result.errors ?? []).map((e) => e.message ?? e).join(", ");
      notes.refresh();
    }
    if (action.startsWith("delete:")) await ctx.call("data", "delete", "learning", action.slice(7));
  });
}
