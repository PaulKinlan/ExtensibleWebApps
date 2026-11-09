// Readability: the post's reading grade in the status bar, long sentences
// underlined, and a readability report agents can run as a tool. "Shorten
// long sentences" asks the writer agent to work on them.

export const manifest = {
  id: "readability",
  name: "Readability",
  description: "Shows the post's reading grade, underlines long sentences, and gives agents a readability report.",
  version: "2.0.0",
  order: 50,
  permissions: ["ui", "document:read", "bus:send:writer", "hook:listen:posts:open", "hook:listen:posts:change", "hook:listen:posts:close"],
  services: ["document", "bus"],
};

const LONG = 30;

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

/** Sentences with their offsets: one ends at . ! or ? before a space, or at a blank line. */
function sentences(text) {
  const out = [];
  const re = /\S(?:[^\n]|\n(?!\s*\n))*?(?:[.!?]+(?=\s|$)|(?=\n\s*\n)|$)/g;
  for (const m of text.matchAll(re)) if (/[A-Za-z]/.test(m[0])) out.push({ text: m[0], from: m.index, to: m.index + m[0].length });
  return out;
}

const words = (text) => text.match(/[A-Za-z0-9’']+/g) ?? [];

function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

/** The Flesch-Kincaid grade, and the sentences over LONG words. */
function analyse(post) {
  const list = sentences(prose(post)).map((s) => ({ ...s, words: words(s.text).length }));
  const all = list.flatMap((s) => words(s.text));
  const syllableCount = all.reduce((n, w) => n + syllables(w), 0);
  const grade = all.length && list.length ? 0.39 * (all.length / list.length) + 11.8 * (syllableCount / all.length) - 15.59 : 0;
  return { grade: Math.max(0, grade), sentences: list, words: all.length, long: list.filter((s) => s.words > LONG) };
}

export default async function (ctx) {
  let underline = (await ctx.storage.get("underline")) ?? true;
  let post = null;

  const update = (p = post) => {
    post = p;
    if (!post) return ctx.ui.render("status", "grade", null);
    const result = analyse(post);
    ctx.ui.render("status", "grade", { type: "text", text: `Grade ${result.grade.toFixed(1)}`, title: `Flesch-Kincaid grade level over ${result.words} words. ${result.long.length} sentences over ${LONG} words.` });
    void ctx.call("document", "annotate", "long-sentences", underline ? result.long.map((s) => ({ from: s.from, to: s.to, severity: "info", message: `Long sentence: ${s.words} words` })) : []);
  };
  ctx.on("posts:open", update);
  ctx.on("posts:change", update);
  ctx.on("posts:close", () => update(null));

  ctx.commands.add({ id: "toggle", title: "Show or hide long sentences", keys: ["Mod+Shift+L"] }, async () => {
    underline = !underline;
    await ctx.storage.set("underline", underline);
    update();
    return underline ? "Underlining long sentences" : "Long sentences hidden";
  });

  ctx.commands.add(
    { id: "readability-report", title: "Readability report", group: "Tools", description: `Reading grade of the post and every sentence over ${LONG} words, with line numbers. Use it before shortening or simplifying prose.`, args: { type: "object", properties: {} } },
    async () => {
      const open = await ctx.call("document", "read");
      if (!open) return "No post is open.";
      const result = analyse(open);
      return [
        `Flesch-Kincaid grade ${result.grade.toFixed(1)} over ${result.words} words in ${result.sentences.length} sentences.`,
        result.long.length ? `Sentences over ${LONG} words:` : `No sentences over ${LONG} words.`,
        ...result.long.map((s) => `- line ${lineOf(open.text, s.from)} (${s.words} words): ${s.text}`),
      ].join("\n");
    },
  );

  ctx.commands.add({ id: "shorten", title: "Shorten long sentences", group: "Quick edits" }, () =>
    ctx.call("bus", "send", "writer", `Run readability/readability-report, then edit the post to split or shorten each sentence over ${LONG} words. Keep my voice and every claim.`),
  );

  update(await ctx.call("document", "read"));
}
