// Style guide: the site's own writing rules. Words to replace or avoid come
// from .editor/style-guide.json in the site folder and are underlined; the
// prose guide in .editor/style-guide.md is what the writer agent follows
// when "Apply style guide" asks it to.

export const manifest = {
  id: "style-guide",
  name: "Style guide",
  description: "Underlines words your site's style guide replaces or avoids (.editor/style-guide.json), and has the writer agent apply the guide (.editor/style-guide.md).",
  version: "2.0.0",
  order: 70,
  permissions: ["ui", "document:read", "folder:read", "bus:send:writer", "hook:listen:posts:open", "hook:listen:posts:change", "hook:listen:posts:close"],
  services: ["document", "folder", "bus"],
};

const RULES_FILE = ".editor/style-guide.json";
const GUIDE_FILE = ".editor/style-guide.md";
const EXAMPLE = '{ "replace": { "utilise": "use", "e-mail": "email" }, "avoid": ["very", "just", "basically"] }';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

/** The post's prose, with front matter, code, shortcodes, HTML and link targets blanked, so offsets still line up. */
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

/** The rules as patterns, each with the word and its replacement, if it has one. */
function compile(rules) {
  const flags = rules.caseSensitive ? "g" : "gi";
  return [
    ...Object.entries(rules.replace ?? {}).map(([from, to]) => ({ re: new RegExp(`\\b${escapeRe(from)}\\b`, flags), word: from, replace: String(to) })),
    ...(rules.avoid ?? []).map((word) => ({ re: new RegExp(`\\b${escapeRe(word)}\\b`, flags), word })),
  ];
}

function findIssues(post, rules) {
  const text = prose(post);
  const issues = [];
  for (const rule of rules) {
    for (const m of text.matchAll(rule.re)) {
      issues.push({ from: m.index, to: m.index + m[0].length, message: rule.replace ? `Style guide: “${rule.replace}”, not “${m[0]}”` : `Style guide: avoid “${m[0]}”` });
    }
  }
  return issues.sort((a, b) => a.from - b.from);
}

export default async function (ctx) {
  let rules = [];
  let problem = "";
  let loaded = false;

  /** Reads the site's rules once for each post opened, and again when the report is asked for (the rules file may be what changed). */
  const load = async () => {
    if (loaded) return;
    loaded = true;
    rules = [];
    problem = "";
    try {
      const json = await ctx.call("folder", "read", RULES_FILE);
      if (json) rules = compile(JSON.parse(json));
    } catch (error) {
      problem = `${RULES_FILE} isn't valid: ${error instanceof Error ? error.message : error}. It looks like ${EXAMPLE}`;
    }
  };

  const update = async (post) => {
    if (!post) return ctx.ui.render("status", "style", null);
    await load();
    if (problem) return ctx.ui.render("status", "style", { type: "text", text: "Style guide: invalid", title: problem, tone: "error" });
    if (!rules.length) {
      ctx.ui.render("status", "style", null);
      return ctx.call("document", "annotate", "style", []);
    }
    const issues = findIssues(post, rules);
    ctx.ui.render("status", "style", { type: "text", text: issues.length ? `Style: ${issues.length}` : "Style ✓", title: issues.length ? `${issues.length} places break the style guide` : "Follows the style guide" });
    await ctx.call("document", "annotate", "style", issues.slice(0, 300).map((i) => ({ from: i.from, to: i.to, severity: "warning", message: i.message })));
  };
  // A post that opens may be in another site folder, with rules of its own: read them again.
  ctx.on("posts:open", (post) => {
    loaded = false;
    return update(post);
  });
  ctx.on("posts:change", update);
  ctx.on("posts:close", () => update(null));

  ctx.commands.add(
    { id: "style-guide-issues", title: "Style guide issues", group: "Tools", description: `Places in the open post that break the site's style guide word rules (${RULES_FILE}), with the replacement where there is one. The prose guide is ${GUIDE_FILE}.`, args: { type: "object", properties: {} } },
    async () => {
      const post = await ctx.call("document", "read");
      if (!post) return "No post is open.";
      loaded = false;
      await load();
      if (!rules.length) return `This site has no ${RULES_FILE}. It looks like ${EXAMPLE}.`;
      const issues = findIssues(post, rules);
      return issues.length ? issues.map((i) => `- line ${lineOf(post.text, i.from)}: ${i.message}`).join("\n") : "The post follows the style guide.";
    },
  );
  ctx.commands.add({ id: "apply", title: "Apply style guide", group: "Quick edits" }, () =>
    ctx.call("bus", "send", "writer", `Run style-guide/style-guide-issues and read ${GUIDE_FILE} from the site folder if there is one, then edit the post to bring it in line with the guide. Rewrite around avoided words rather than just deleting them.`),
  );
  update(await ctx.call("document", "read"));
}
