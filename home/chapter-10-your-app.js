// Chapter 10, an app of your own. Its words are in chapter-10-your-app.html:
// what an app is, the one command that makes a project of your own
// (scripts/create-app.mjs), and how to put the app online by itself
// (scripts/deploy-app.mjs). It only draws, so it asks for nothing but ui.

export const manifest = {
  id: "chapter-10-your-app",
  name: "Chapter 10: An app of your own",
  description: "Explains how to make a customizable app of your own with one command, run it, and put it online by itself.",
  version: "1.0.0",
  permissions: ["ui"],
  scope: "tab",
};

/** The smallest app.html, shown in the chapter (sent as data, so the page shows it as text). */
const APP_HTML = `<!doctype html>
<title>Packing list</title>
<link rel="stylesheet" href="/platform/host.css">
<script type="module" src="/platform/host.js"></script>
<link rel="plugin" href="main.js">
<link rel="plugin" href="/std/switchboard.js">

<h1>Packing list</h1>
<slot name="main"></slot>
<slot name="switchboard"></slot>`;

export default function (ctx) {
  ctx.ui.views("chapter-10-your-app.html").render("your-app", "chapter", { appHtml: APP_HTML });
}
