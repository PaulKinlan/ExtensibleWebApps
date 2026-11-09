// Word count: the open note's words and reading time in the status bar. It
// hears the note through the notes plugin's hooks.

export const manifest = {
  id: "word-count",
  name: "Word count",
  order: 10,
  description: "Shows the note's word count and reading time in the status bar.",
  version: "2.0.0",
  permissions: ["ui", "hook:listen:notes:open", "hook:listen:notes:change", "hook:listen:notes:save", "hook:listen:notes:close"],
};

const WORDS_PER_MINUTE = 230;

function count(note) {
  return (note.text.slice(note.bodyStart).match(/[\p{L}\p{N}’']+/gu) ?? []).length;
}

export default function (ctx) {
  const show = (note) => {
    if (!note) return ctx.ui.render("status", "words", null);
    const words = count(note);
    const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
    ctx.ui.render("status", "words", { type: "text", text: `${words.toLocaleString()} words · ${minutes} min read`, title: `Reading time at ${WORDS_PER_MINUTE} words a minute` });
  };
  ctx.on("notes:open", show);
  ctx.on("notes:change", show);
  ctx.on("notes:save", show);
  ctx.on("notes:close", () => show(null));
}
