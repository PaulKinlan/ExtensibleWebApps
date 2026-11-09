// Repetition: underlines words used again soon after, and gives the post's
// most used words in the status bar's tooltip. Off until you add it in
// Customize (the app offers it), as in the editor.

export const manifest = {
  id: "repetition",
  name: "Repetition",
  description: "Underlines words repeated within a few lines of each other, and shows your most used words.",
  version: "2.0.0",
  order: 60,
  permissions: ["ui", "document:read", "hook:listen:posts:open", "hook:listen:posts:change", "hook:listen:posts:close"],
  services: ["document"],
};

const WINDOW = 40;
const STOP = new Set(
  "about above after again against also because been before being below between both could does doing down during each every from further have having here into itself just more most much must only other over same should some such than that their theirs them then there these they this those through under until very what when where which while will with would your yours yourself really thing things like make made want need know".split(" "),
);

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

/** Words of four letters or more, lowercased, with offsets. */
const tokens = (post) => [...prose(post).matchAll(/[A-Za-z][A-Za-z’']{3,}/g)].map((m) => ({ word: m[0].toLowerCase().replace(/[’']s$/, ""), from: m.index, to: m.index + m[0].length }));

function analyse(post) {
  const repeats = [];
  const counts = new Map();
  const lastSeen = new Map();
  tokens(post).forEach((t, i) => {
    if (STOP.has(t.word)) return;
    counts.set(t.word, (counts.get(t.word) ?? 0) + 1);
    const before = lastSeen.get(t.word);
    if (before !== undefined && i - before <= WINDOW) repeats.push({ ...t, gap: i - before });
    lastSeen.set(t.word, i);
  });
  const top = [...counts].filter(([, n]) => n > 2).sort((a, b) => b[1] - a[1]).slice(0, 10);
  return { repeats, top };
}

export default async function (ctx) {
  let underline = (await ctx.storage.get("underline")) ?? true;
  let post = null;

  const update = (p = post) => {
    post = p;
    if (!post) return ctx.ui.render("status", "repeats", null);
    const { repeats, top } = analyse(post);
    ctx.ui.render("status", "repeats", repeats.length ? { type: "text", text: `${repeats.length} repeats`, title: top.length ? `Most used: ${top.map(([w, n]) => `${w} (${n})`).join(", ")}` : "" } : null);
    void ctx.call("document", "annotate", "repeats", underline ? repeats.slice(0, 300).map((r) => ({ from: r.from, to: r.to, severity: "info", message: `“${r.word}” again, ${r.gap} words after the last one` })) : []);
  };
  ctx.on("posts:open", update);
  ctx.on("posts:change", update);
  ctx.on("posts:close", () => update(null));

  ctx.commands.add({ id: "toggle", title: "Show or hide repeated words" }, async () => {
    underline = !underline;
    await ctx.storage.set("underline", underline);
    update();
  });
  ctx.commands.add(
    { id: "repeated-words", title: "Repeated words", group: "Tools", description: `Words repeated within ${WINDOW} words of each other in the open post, and its most used words. Use it before varying word choice.`, args: { type: "object", properties: {} } },
    async () => {
      const open = await ctx.call("document", "read");
      if (!open) return "No post is open.";
      const { repeats, top } = analyse(open);
      const grouped = new Map();
      for (const r of repeats) grouped.set(r.word, (grouped.get(r.word) ?? 0) + 1);
      return [
        `Most used words: ${top.map(([w, n]) => `${w} (${n})`).join(", ") || "none used more than twice"}.`,
        grouped.size ? `Repeated close together: ${[...grouped].map(([w, n]) => `${w} ×${n}`).join(", ")}.` : "No close repeats.",
      ].join("\n");
    },
  );
  update(await ctx.call("document", "read"));
}
