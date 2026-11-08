// Chapter 5, look inside. Its words are in chapter-5-inspect.html; view
// source (/std/view-source.js) and the hook tracer (/std/hook-tracer.js)
// draw themselves just below it.

export const manifest = {
  id: "chapter-5-inspect",
  name: "Chapter 5: Look inside",
  description: "Explains how to see any plugin's code and follow the hooks an action runs, above view source and the hook tracer.",
  version: "1.0.0",
  permissions: ["ui"],
};

export default function (ctx) {
  ctx.ui.views("chapter-5-inspect.html").render("inspect", "chapter", {}, { order: 1 });
}
