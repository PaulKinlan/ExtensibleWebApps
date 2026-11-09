// Tag suggester: suggests the site's existing tags that fit the post, so new
// posts reuse tags instead of inventing near-duplicates. "Suggest tags…"
// opens a panel of them; picking one adds it to the post's front matter.
// Agents get the same list as a tool, and "Suggest tags" asks the writer.

export const manifest = {
  id: "tag-suggester",
  name: "Tag suggester",
  description: "Suggests tags the site already uses that fit the post, adds the one you pick, and gives agents a suggest-tags tool.",
  version: "2.0.0",
  order: 110,
  permissions: ["ui", "document:read", "document:write", "bus:send:writer", "hook:listen:posts:open", "hook:listen:posts:close"],
  services: ["document", "bus"],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The post's prose, with front matter, code, shortcodes, HTML and link targets blanked. */
function prose(post) {
  const blank = (match) => match.replace(/[^\n]/g, " ");
  return (" ".repeat(post.bodyStart) + post.text.slice(post.bodyStart))
    .replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, blank)
    .replace(/\{\{[<%][\s\S]*?[%>]\}\}/g, blank)
    .replace(/<[^>\n]+>/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\]\([^)\n]*\)/g, blank)
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s/gm, blank);
}

const listOf = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/** Existing tags that fit the post, best first, with how often the post and the site use them. */
function suggest(post, posts, field = "tags") {
  const current = new Set(listOf(post.frontMatter?.[field]).map((t) => t.toLowerCase()));
  const usage = new Map();
  for (const p of posts) if (p.path !== post.path) for (const t of p[field] ?? []) usage.set(t, (usage.get(t) ?? 0) + 1);
  const text = `${post.title} ${prose(post)}`.toLowerCase();
  const scored = [];
  for (const [tag, used] of usage) {
    if (current.has(tag.toLowerCase())) continue;
    const phrase = tag.toLowerCase().replace(/[-_]+/g, " ");
    const hits = (text.match(new RegExp(`\\b${escapeRe(phrase)}s?\\b`, "g")) ?? []).length;
    if (hits) scored.push({ tag, hits, used, score: hits * (1 + Math.log(1 + used)) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 12);
}

export default function (ctx) {
  /** The suggestions on show, or null when the panel is closed. */
  let shown = null;
  let note = "";
  const draw = () => {
    if (!shown) return ctx.ui.render("panels", "tags", null);
    ctx.ui.views("tag-suggester.html").render("panels", "tags", { tags: shown.map((s, i) => ({ ...s, i })), none: !shown.length, note });
  };

  const open = async () => {
    const post = await ctx.call("document", "read");
    if (!post) return "Open a post first.";
    shown = suggest(post, await ctx.call("document", "list"));
    note = "";
    draw();
  };
  ctx.commands.add({ id: "suggest", title: "Suggest tags…" }, open);
  ctx.ui.render("toolbar", "button", { type: "button", label: "Tags", action: "toggle" });
  ctx.ui.onEvent(async (action) => {
    if (action === "toggle") return shown ? ((shown = null), draw()) : open();
    if (action === "close") shown = null;
    const pick = action.startsWith("add:") && shown?.[Number(action.slice(4))];
    if (pick) {
      const post = await ctx.call("document", "read");
      if (post) {
        const tags = listOf(post.frontMatter?.tags);
        await ctx.call("document", "setFrontMatter", "tags", [...tags, pick.tag]);
        shown = shown.filter((s) => s !== pick);
        note = `Added “${pick.tag}”.`;
      }
    }
    draw();
  });
  ctx.on("posts:open", () => {
    shown = null;
    draw();
  });
  ctx.on("posts:close", () => {
    shown = null;
    draw();
  });

  ctx.commands.add(
    {
      id: "suggest-tags",
      title: "Suggest tags (list)",
      group: "Tools",
      description: "Tags (or categories) the site already uses that fit the open post, scored by how often the post mentions them and how many posts use them. Prefer these to new tags.",
      args: { type: "object", properties: { field: { type: "string", enum: ["tags", "categories"], description: "Which taxonomy (default tags)" } } },
    },
    async ({ field } = {}) => {
      const post = await ctx.call("document", "read");
      if (!post) return "No post is open.";
      const list = suggest(post, await ctx.call("document", "list"), field === "categories" ? "categories" : "tags");
      return list.length ? list.map((s) => `- ${s.tag}: mentioned ${s.hits}×, used on ${s.used} posts`).join("\n") : "None of the site's existing terms appear in this post.";
    },
  );
  ctx.commands.add({ id: "tags", title: "Suggest tags", group: "Quick edits" }, () =>
    ctx.call("bus", "send", "writer", "Run tag-suggester/suggest-tags, pick the 3 to 5 that fit best (only invent a new tag if nothing fits), and set the post's front matter tags."),
  );
}
