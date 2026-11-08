// Note stats: how many learning notes you've written, and how many words.
//
// It doesn't own the notes. It asks to read them (`data:read:learning`),
// which also lets it hear when they change, and its view is live, so it
// redraws whenever a note is added or deleted. Switch it off, and the notes
// carry on without it: neither plugin knows the other is there.

export const manifest = {
  id: "note-stats",
  name: "Note stats",
  description: "Counts your learning notes and their words. It reads the notes; it doesn't own them.",
  version: "1.0.0",
  permissions: ["ui", "data:read:learning"],
};

export default function (ctx) {
  ctx.ui.live("playground", "stats", async (ctx) => {
    const notes = await ctx.call("data", "list", "learning");
    const words = notes.reduce((n, note) => n + (note.text.match(/[\p{L}\p{N}’']+/gu) ?? []).length, 0);
    return ctx.ui.html`<ui-stack direction="row" gap="3"><ui-stat label="Notes" value="${notes.length}"></ui-stat><ui-stat label="Words" value="${words}"></ui-stat></ui-stack>`;
  }, 20);
}
