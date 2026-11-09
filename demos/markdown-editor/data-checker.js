// Data checker: finds the numbers, dates, money amounts and quotes in a
// post, lists them in a Claims panel, and asks the writer agent to check
// one against the site's data files and its sources. Agents can list the
// claims and read the site's data files as tools.

export const manifest = {
  id: "data-checker",
  name: "Data checker",
  description: "Lists every number, date, money amount and quote in the post, and has the writer agent check them.",
  version: "2.0.0",
  order: 100,
  permissions: ["ui", "document:read", "folder:read", "bus:send:writer", "hook:listen:posts:open", "hook:listen:posts:change", "hook:listen:posts:close"],
  services: ["document", "folder", "bus"],
};

const PATTERNS = [
  ["money", /[$£€¥]\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|bn|billion|million|thousand)?\b/gi],
  ["percent", /\b\d+(?:\.\d+)?\s?(?:%|percent\b|per cent\b)/gi],
  ["date", /\b(?:\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4}|(?:19|20)\d{2})\b/g],
  ["number", /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s?(?:x|×|times|k|m|ms|s|GB|MB|KB|tokens|users|people)\b|\b\d+\.\d+\b|\b\d{2,}\b/g],
  ["quote", /[“"][^”"\n]{12,300}[”"]/g],
];
const DATA_FILE = /^(data|static|assets)\/.+\.(json|csv|tsv|ya?ml|toml|txt)$/;

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

/** Claims in the post: each match with its kind, line and sentence, without overlaps. */
function findClaims(post) {
  const text = prose(post);
  const found = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const from = m.index;
      const to = from + m[0].length;
      if (found.some((c) => from < c.to && to > c.from)) continue;
      found.push({ kind, from, to, value: post.text.slice(from, to).trim() });
    }
  }
  found.sort((a, b) => a.from - b.from);
  return found.map((c, i) => {
    const start = Math.max(text.lastIndexOf("\n\n", c.from), Math.max(text.lastIndexOf(". ", c.from), 0));
    const end = [text.indexOf(". ", c.to), text.indexOf("\n\n", c.to), text.length].filter((n) => n >= 0).sort((a, b) => a - b)[0];
    return { ...c, i, line: lineOf(post.text, c.from), context: post.text.slice(start, end + 1).replace(/^[.\s]+/, "").replace(/\s+/g, " ").trim() };
  });
}

export default async function (ctx) {
  let claims = [];
  let open = false;

  const update = (post) => {
    open = !!post;
    claims = post ? findClaims(post) : [];
    ctx.ui.render("status", "claims", post && claims.length ? { type: "text", text: `${claims.length} claims`, title: "Numbers, dates and quotes to check (Claims panel)" } : null);
    ctx.ui.views("data-checker.html").render("panels", "claims", { open, claims, count: claims.length });
  };
  ctx.on("posts:open", update);
  ctx.on("posts:change", update);
  ctx.on("posts:close", () => update(null));

  ctx.ui.onEvent((action) => {
    const claim = action.startsWith("check:") && claims[Number(action.slice(6))];
    if (!claim) return;
    return ctx.call(
      "bus",
      "send",
      "writer",
      `Check this ${claim.kind} on line ${claim.line}: "${claim.value}" in "${claim.context}". Use data-checker/read-site-data for the site's data files. Say whether it is confirmed, wrong or unverifiable, with the source, and edit the post only if it is wrong.`,
    );
  });

  ctx.commands.add(
    { id: "list-claims", title: "List claims", group: "Tools", description: "Every number, percentage, money amount, date and quote in the post, with its line and sentence, so each can be checked.", args: { type: "object", properties: {} } },
    async () => {
      const post = await ctx.call("document", "read");
      if (!post) return "No post is open.";
      const found = findClaims(post);
      return found.length ? found.map((c) => `${c.i + 1}. [${c.kind}] line ${c.line}: ${c.value}\n   ${c.context}`).join("\n") : "No numbers, dates or quotes found.";
    },
  );
  ctx.commands.add(
    {
      id: "read-site-data",
      title: "Read a site data file",
      group: "Tools",
      description: "Reads a data file from the site folder (under data/, static/ or assets/; JSON, CSV, TSV, YAML, TOML or text), to check figures in the post against it.",
      args: { type: "object", properties: { path: { type: "string", description: "Path from the site root, e.g. data/benchmarks.json" } }, required: ["path"] },
    },
    async ({ path }) => {
      const clean = String(path).replace(/^\/+/, "");
      if (!DATA_FILE.test(clean) || clean.split("/").includes("..")) return `Only data files under data/, static/ or assets/ can be read, not ${clean}.`;
      const text = await ctx.call("folder", "read", clean);
      if (text === null) return `No file at ${clean}.`;
      return text.length > 40_000 ? `${text.slice(0, 40_000)}\n… (cut at 40,000 characters)` : text;
    },
  );
  ctx.commands.add({ id: "check-numbers", title: "Check numbers", group: "Quick edits" }, () =>
    ctx.call("bus", "send", "writer", "Check every number, date, money amount and quote in the post: run data-checker/list-claims, check each against the site's data files (data-checker/read-site-data), report a table of claim, status and source, and edit the post only for claims that are wrong."),
  );
  update(await ctx.call("document", "read"));
}
