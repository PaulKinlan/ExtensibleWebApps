// The docs panel: the docs, inside the page you're on. A "Docs" switch in
// the page's tools opens a panel with the page of the docs about what you're
// looking at, drawn from the same Markdown files /docs/ draws
// (<ui-markdown>), with a list to pick another. An app links it with
// <link rel="plugin" href="/docs/panel.js"> and gives it two slots:
// `page-tools` for the switch, and `docs` for the panel, which the page's own
// CSS places (the homepage docks it to the right).
//
// It lives in docs/ because its template must sit beside the files it draws:
// a view may only fetch Markdown from its own folder or below.

export const manifest = {
  id: "docs-panel",
  name: "Docs panel",
  description: "Opens the docs beside the page, at the page about what you're reading.",
  version: "1.0.0",
  permissions: ["ui"],
  scope: "tab",
};

/** The pages the panel offers, in the order a reader of the homepage meets them. */
const PAGES = [
  { file: "README.md", title: "Start here" },
  { file: "architecture.md", title: "How it fits together" },
  { file: "guide/writing-a-plugin.md", title: "Writing a plugin" },
  { file: "guide/plugin-hooks.md", title: "Hooks of your own" },
  { file: "guide/debugging.md", title: "Looking inside" },
  { file: "permissions.md", title: "Permissions" },
  { file: "guide/data-and-permissions.md", title: "Data and review" },
  { file: "guide/views-and-templates.md", title: "Views and templates" },
  { file: "guide/how-an-app-works.md", title: "How an app works" },
  { file: "guide/agents.md", title: "Agents" },
  { file: "security.md", title: "Security" },
  { file: "glossary.md", title: "Glossary" },
];
const REPO = "https://github.com/PaulKinlan/ExtensibleWebApps";

export default function (ctx) {
  const views = ctx.ui.views("panel.html");
  let open = false;
  let file = PAGES[0].file;

  const draw = () => {
    views.render("page-tools", "switch", { pressed: String(open) }, { order: 5 });
    if (!open) return ctx.ui.render("docs", "panel", null);
    const page = PAGES.find((p) => p.file === file);
    views.render("docs", "panel", {
      file,
      title: page?.title ?? file,
      pages: PAGES.map((p) => ({ ...p, current: p.file === file })),
      full: `/docs/${file.replace(/README\.md$/, "").replace(/\.md$/, "")}`,
      repo: REPO,
    });
  };

  ctx.ui.onEvent((action, value) => {
    if (action === "docs") open = !open;
    else if (action === "close") open = false;
    else if (action === "page" && PAGES.some((p) => p.file === value)) file = value;
    else return;
    draw();
  });
  draw();
}
