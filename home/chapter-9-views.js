// Chapter 9, views are HTML. Its words are in chapter-9-views.html. Below
// them, it draws whatever HTML you type, as it is, with ctx.ui.render: the
// page keeps only what's on its allowlist, so you can see what a plugin's
// view can and can't do.

export const manifest = {
  id: "chapter-9-views",
  name: "Chapter 9: Views are HTML",
  description: "Explains how plugins draw, and draws any HTML you type so you can see what the page keeps.",
  version: "1.0.0",
  permissions: ["ui"],
  scope: "tab",
};

/** A start that has something the page keeps, and something it drops, of each kind. */
const EXAMPLE = `<h3>Hello from your HTML</h3>
<p onclick="alert('hi')" style="color: red">A paragraph with an onclick and a style.</p>
<script>alert("a script")</script>
<ui-badge tone="ok">a platform component</ui-badge>
<a href="javascript:alert('a link')">A javascript: link</a>
<img src="https://example.com/cat.png" alt="(a picture from another site)">`;

/** How a plugin usually draws, shown in the chapter. */
const TEMPLATE = `<template id="count"><ui-stat label="Notes" value="{{n}}"></ui-stat></template>

views.render("side", "count", { n: notes.length });`;

/** The most HTML it draws. */
const MAX = 4000;

export default function (ctx) {
  const views = ctx.ui.views("chapter-9-views.html");
  let html = EXAMPLE;
  const draw = () => {
    views.render("views", "chapter", { html, template: TEMPLATE }, { order: 1 });
    // The person's HTML goes to the page as written, not through a template: the host's sanitiser is what keeps it safe.
    ctx.ui.render("views", "drawn", `<ui-card class="drawn"><p><small>What the page drew from your HTML:</small></p>${html}</ui-card>`, 2);
  };
  draw();
  ctx.ui.onEvent((action, value) => {
    if (action === "draw") html = String(value?.html ?? "").slice(0, MAX);
    if (action === "example") html = EXAMPLE;
    if (action === "draw" || action === "example") draw();
  });
}
