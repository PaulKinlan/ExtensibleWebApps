// SEO check: title and description length, a missing summary, heading
// order, image alt text and vague link text, in the status bar and as
// underlines, with a report agents run as a tool and a "Fix SEO issues"
// quick edit for the writer agent.

export const manifest = {
  id: "seo-check",
  name: "SEO check",
  description: "Checks title and description length, heading order, image alt text and link text, and gives agents an SEO report.",
  version: "2.0.0",
  order: 80,
  permissions: ["ui", "document:read", "bus:send:writer", "hook:listen:posts:open", "hook:listen:posts:change", "hook:listen:posts:close"],
  services: ["document", "bus"],
};

const TITLE = [20, 60];
const DESCRIPTION = [50, 160];
const VAGUE = /^(here|click here|this|link|this link|read more|more)$/i;

const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

/** The post's ATX headings outside code, with level, text and offsets. */
function headings(post) {
  const out = [];
  let fence = null;
  let offset = post.bodyStart;
  for (const line of post.text.slice(post.bodyStart).split("\n")) {
    const f = line.match(/^\s{0,3}(```|~~~)/);
    if (f) fence = fence === f[1] ? null : (fence ?? f[1]);
    else if (!fence) {
      const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) out.push({ level: h[1].length, text: h[2], from: offset, to: offset + line.length });
    }
    offset += line.length + 1;
  }
  return out;
}

function check(post) {
  const fm = post.frontMatter ?? {};
  const issues = [];
  const title = String(fm.seotitle ?? fm.title ?? "");
  const titleField = fm.seotitle ? "seotitle" : "title";
  if (!title) issues.push({ level: "warning", message: "No title." });
  else if (title.length > TITLE[1]) issues.push({ level: "warning", message: `The ${titleField} is ${title.length} characters; search results cut it off after about ${TITLE[1]}.` });
  else if (title.length < TITLE[0]) issues.push({ level: "info", message: `The ${titleField} is only ${title.length} characters; ${TITLE[0]}–${TITLE[1]} gives search results more to show.` });
  const descriptionField = ["description", "summary", "seodescription"].find((k) => fm[k]);
  const description = descriptionField ? String(fm[descriptionField]) : "";
  if (!description) issues.push({ level: "warning", message: "No description or summary in the front matter, so search engines pick their own snippet." });
  else if (description.length > DESCRIPTION[1]) issues.push({ level: "info", message: `The ${descriptionField} is ${description.length} characters; search results show about ${DESCRIPTION[1]}.` });
  else if (description.length < DESCRIPTION[0]) issues.push({ level: "info", message: `The ${descriptionField} is only ${description.length} characters.` });

  let previous = 1;
  for (const h of headings(post)) {
    if (h.level === 1) issues.push({ level: "info", message: "A level 1 heading in the body; most themes already show the title as the page's h1.", from: h.from, to: h.to });
    else if (h.level > previous + 1) issues.push({ level: "warning", message: `Heading jumps from level ${previous} to ${h.level}.`, from: h.from, to: h.to });
    previous = h.level;
  }
  const body = post.text.slice(post.bodyStart);
  const at = (m) => ({ from: post.bodyStart + m.index, to: post.bodyStart + m.index + m[0].length });
  for (const m of body.matchAll(/!\[([^\]]*)\]\([^)]*\)/g)) if (!m[1].trim()) issues.push({ level: "warning", message: "Image without alt text.", ...at(m) });
  for (const m of body.matchAll(/\{\{<\s*figure\b[^>]*>\}\}/g)) if (!/\balt\s*=\s*"[^"]+"/.test(m[0])) issues.push({ level: "warning", message: "Figure without alt text.", ...at(m) });
  for (const m of body.matchAll(/(?<!!)\[([^\]]+)\]\([^)]*\)/g)) if (VAGUE.test(m[1].trim())) issues.push({ level: "info", message: `Link text “${m[1]}” doesn't say where it goes.`, ...at(m) });
  return issues;
}

export default async function (ctx) {
  const update = (post) => {
    if (!post) return ctx.ui.render("status", "seo", null);
    const issues = check(post);
    ctx.ui.render("status", "seo", { type: "text", text: issues.length ? `SEO: ${issues.length} to check` : "SEO ✓", title: issues.map((i) => `• ${i.message}`).join("\n") || "No SEO issues found." });
    void ctx.call("document", "annotate", "seo", issues.filter((i) => i.from !== undefined).map((i) => ({ from: i.from, to: i.to, severity: i.level, message: `SEO: ${i.message}` })));
  };
  ctx.on("posts:open", update);
  ctx.on("posts:change", update);
  ctx.on("posts:close", () => update(null));

  ctx.commands.add(
    { id: "seo-report", title: "SEO report", group: "Tools", description: "SEO problems in the open post: title and description length, missing summary, heading order, images without alt text, vague link text. Use before improving a post's SEO.", args: { type: "object", properties: {} } },
    async () => {
      const post = await ctx.call("document", "read");
      if (!post) return "No post is open.";
      const issues = check(post);
      return issues.length ? issues.map((i) => `- [${i.level}]${i.from !== undefined ? ` line ${lineOf(post.text, i.from)}:` : ""} ${i.message}`).join("\n") : "No SEO issues found.";
    },
  );
  ctx.commands.add({ id: "fix", title: "Fix SEO issues", group: "Quick edits" }, () =>
    ctx.call("bus", "send", "writer", "Run seo-check/seo-report, then edit the post to fix each issue: a title and description of the right length in my voice, alt text that describes each image, clearer link text and heading levels. Say which you'd leave alone."),
  );
  update(await ctx.call("document", "read"));
}
