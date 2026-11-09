// Outline: the post's headings, with the words in each section, in a panel.
// Click one to jump to it.

export const manifest = {
  id: "outline",
  name: "Outline",
  description: "Shows the post's headings, with words per section, in an Outline panel. Click a heading to jump to it.",
  version: "2.0.0",
  order: 120,
  permissions: ["ui", "document:read", "hook:listen:posts:open", "hook:listen:posts:change", "hook:listen:posts:close"],
  services: ["document"],
};

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

const wordsIn = (text) => (text.match(/[\p{L}\p{N}’']+/gu) ?? []).length;

function sections(post) {
  const list = headings(post);
  return list.map((h, i) => {
    const end = i + 1 < list.length ? list[i + 1].from : post.text.length;
    return { ...h, i, words: wordsIn(post.text.slice(h.to, end)), indent: h.level - 1 };
  });
}

export default async function (ctx) {
  let list = [];
  const draw = (post) => {
    list = post ? sections(post) : [];
    ctx.ui.views("outline.html").render("panels", "outline", { open: !!post, sections: list, empty: !!post && !list.length });
  };
  ctx.ui.onEvent((action) => {
    const h = action.startsWith("jump:") && list[Number(action.slice(5))];
    // The caret goes to the end of the heading, and the editor scrolls to it.
    if (h) void ctx.call("document", "select", h.to, h.to);
  });
  ctx.on("posts:open", draw);
  ctx.on("posts:change", draw);
  ctx.on("posts:close", () => draw(null));
  draw(await ctx.call("document", "read"));
}
