// Spell check: turns the browser's own spell checker on in the editor, and
// teaches it the site's words so they aren't marked: every tag and category
// the site's posts use (mostly product names and jargon), and the words in
// the site's .editor/words.txt, one or more to a line. Chrome 159 and later
// have the custom dictionary that takes them; other browsers check the
// spelling but mark the site's words too. The toolbar button turns it off and
// on, and the choice is kept.

export const manifest = {
  id: "spell-check",
  name: "Spell check",
  description: "Checks the spelling as you write, with the browser's spell checker, and accepts the site's tags and its own word list.",
  version: "1.0.0",
  order: 150,
  permissions: ["ui", "document:read", "document:write", "folder:read", "hook:listen:posts:open", "hook:listen:posts:save"],
  services: ["document", "folder"],
};

/** The site's own words: each word of its tags and categories, and its word list. */
export function siteWords(posts, list = "") {
  const words = new Set(list.split(/[\s,]+/).filter(Boolean));
  for (const post of posts) for (const term of [...(post.tags ?? []), ...(post.categories ?? [])]) for (const word of String(term).split(/[\s/]+/)) if (/\p{L}/u.test(word)) words.add(word);
  return [...words].sort();
}

export default async function (ctx) {
  let on = (await ctx.storage.get("on")) ?? true;
  const button = () => ctx.ui.render("toolbar", "toggle", { type: "button", label: on ? "Spelling on" : "Spelling off", action: "toggle" });

  const apply = async () => {
    await ctx.call("document", "setOption", "spellcheck", on);
    if (!on) return;
    const list = (await ctx.call("folder", "read", ".editor/words.txt").catch(() => null)) ?? "";
    await ctx.call("document", "setOption", "words", siteWords(await ctx.call("document", "list"), list));
  };

  ctx.ui.onEvent(async (action) => {
    if (action !== "toggle") return;
    on = !on;
    await ctx.storage.set("on", on);
    button();
    await apply();
  });
  // A save may have added a tag, and another folder may have been opened.
  ctx.on("posts:open", apply);
  ctx.on("posts:save", apply);
  ctx.commands.add({ id: "toggle", title: "Turn spell check on or off" }, async () => {
    on = !on;
    await ctx.storage.set("on", on);
    button();
    await apply();
    return on ? "Spell check is on." : "Spell check is off.";
  });
  button();
  await apply();
}
