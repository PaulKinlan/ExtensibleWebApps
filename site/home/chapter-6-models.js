// Chapter 6, ask a model. Its words are in chapter-6-models.html; Ask the
// page (/std/ask-the-page.js) draws itself just below it, and the language
// models it can ask are the /std/llm/ plugins the page links.

export const manifest = {
  id: "chapter-6-models",
  name: "Chapter 6: Ask a model",
  description: "Explains how a plugin asks a language model without ever holding a key, above Ask the page.",
  version: "1.0.0",
  permissions: ["ui"],
};

export default function (ctx) {
  ctx.ui.views("chapter-6-models.html").render("ask", "chapter", {}, { order: 1 });
}
