// Word goal: a target for the post, from its front matter (wordGoal) or set
// in the Word goal panel, with progress in the status bar.

export const manifest = {
  id: "word-goal",
  name: "Word goal",
  description: "Shows progress towards a word count goal, set per post in its panel or with a wordGoal front matter field.",
  version: "2.0.0",
  order: 20,
  permissions: ["ui", "document:read", "hook:listen:posts:open", "hook:listen:posts:change", "hook:listen:posts:close"],
  services: ["document"],
};

const words = (post) => (post.text.slice(post.bodyStart).match(/[\p{L}\p{N}’']+/gu) ?? []).length;

export default async function (ctx) {
  let goals = (await ctx.storage.get("goals")) ?? {};
  let post = null;
  let asking = false;

  const goalFor = (p) => {
    const fm = p.frontMatter ?? {};
    const fromFrontMatter = Number(fm.wordgoal ?? fm.word_goal ?? fm.wordcount_goal);
    return fromFrontMatter > 0 ? fromFrontMatter : goals[p.path];
  };

  const show = () => {
    const goal = post && goalFor(post);
    if (!goal) ctx.ui.render("status", "goal", post ? { type: "button", label: "Set a word goal", action: "ask" } : null);
    else {
      const n = words(post);
      const percent = Math.round((n / goal) * 100);
      const left = goal - n;
      ctx.ui.render("status", "goal", {
        type: "text",
        text: `${percent >= 100 ? "✓ " : ""}${n.toLocaleString()} / ${goal.toLocaleString()} words`,
        title: left > 0 ? `${left.toLocaleString()} words to go (${percent}%)` : `Goal reached (${percent}%)`,
      });
    }
    if (asking && post) ctx.ui.views("word-goal.html").render("panels", "goal", { goal: goals[post.path] ?? "", title: post.title });
    else ctx.ui.render("panels", "goal", null);
  };

  const follow = (p) => {
    post = p;
    show();
  };
  ctx.on("posts:open", follow);
  ctx.on("posts:change", follow);
  ctx.on("posts:close", () => follow(null));

  ctx.commands.add({ id: "set", title: "Set word goal…" }, () => {
    asking = true;
    show();
  });
  ctx.ui.onEvent(async (action, value) => {
    if (action === "ask") asking = true;
    if (action === "cancel") asking = false;
    if (action === "set" && post) {
      const goal = Math.round(Number(String(value?.goal ?? "").replace(/[,\s]/g, "")));
      if (goal > 0) goals[post.path] = goal;
      else delete goals[post.path];
      await ctx.storage.set("goals", goals);
      asking = false;
    }
    show();
  });
  follow(await ctx.call("document", "read"));
}
