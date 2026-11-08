// Chapter 4, make your own. Its words are in chapter-4-make.html; the
// editor itself is std/plugin-editor.js, drawn just below it.

export const manifest = {
  id: "chapter-4-make",
  name: "Chapter 4: Make your own",
  description: "Explains how to write a plugin for this page, with the plugin editor below it.",
  version: "1.0.0",
  permissions: ["ui"],
};

export default function (ctx) {
  ctx.ui.views("chapter-4-make.html").render("chapters", "chapter", {}, { order: 4 });
}
