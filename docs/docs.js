// The docs: draws the Markdown file the address names. The router service
// says which screen this is, relative to the app's folder: / is README.md, a
// folder (/guide/) is its README.md, and anything else is that path plus .md
// (/guide/agents is guide/agents.md). Links between pages are plain links in
// the Markdown, which <ui-markdown> turns into these addresses, and following
// one doesn't load the page again.
//
// A screen belongs to one tab, so this plugin is `scope: "tab"`: each tab's
// copy draws what its own tab's address says.

export const manifest = {
  id: "docs",
  name: "Docs",
  description: "Draws a page of the docs, from the Markdown file its address names, beside the list of pages.",
  version: "1.0.0",
  permissions: ["ui", "router"],
  scope: "tab",
};

/** Where the source lives, for links to code and to a page's own file. */
const REPO = "https://github.com/PaulKinlan/ExtensibleWebApps";

/** The file a screen shows, relative to this folder; null for an address that can't be one. */
export function fileFor(path) {
  const clean = `/${String(path ?? "").replace(/^\/+/, "")}`;
  if (clean.split("/").some((part) => part === ".." || part === ".")) return null;
  return clean.endsWith("/") ? `${clean.slice(1)}README.md` : `${clean.slice(1)}.md`;
}

export default function (ctx) {
  const views = ctx.ui.views("docs.html");
  views.render("contents", "contents", { repo: REPO });
  const page = views.live("page", "page", async () => {
    const { path } = await ctx.call("router", "current");
    const file = fileFor(path);
    return { file: file ?? "missing.md", repo: REPO, source: `${REPO}/blob/main/docs/${file ?? ""}` };
  });
  ctx.on("router:changed", () => page.refresh());
}
