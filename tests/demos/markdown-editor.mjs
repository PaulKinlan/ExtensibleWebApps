// The Markdown editor: posts.js opens a post from the site folder in a
// <ui-editor> (CodeMirror), and the other plugins hear it through posts:*
// hooks and change it through the `document` service: the status bar, the
// underlines, the outline, the emoji picker, the tag suggester and a paste
// hook. The runner (tests/platform.test.mjs) opens demos/markdown-editor/app.html,
// checks every plugin it links draws, then calls this with that page.
export default async function (page, { check, proof }) {
  const editor = "ui-editor";
  const footer = () => page.textContent("footer");
  const text = () => page.evaluate(() => document.querySelector("ui-editor")?.value ?? "");
  const until = (fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

  // The private folder starts with a sample site, and its first post opens.
  proof.posts = await page.locator('[data-key="posts:files"] .list button').count();
  check("the editor lists the sample site's posts", proof.posts === 2, `${proof.posts} posts`);
  proof.opened = await until(() => document.querySelector("ui-editor")?.value?.includes("Welcome to the editor"));
  check("the first post opens in the CodeMirror editor", proof.opened && !!(await page.$(`${editor} >> .cm-content`)));

  // Front matter: a field's whole value is replaced (an unindented YAML list, a block scalar), a TOML
  // field goes before the first [table], and a brace in a JSON string doesn't end the front matter.
  proof.frontMatter = await page.evaluate(async () => {
    const { setField, parseFrontMatter } = await import("/demos/markdown-editor/posts.js");
    const yaml = setField("---\ntitle: A\ntags:\n- old\nsummary: |\n  one\n  two\n---\nbody", "tags", ["new"]);
    const toml = setField('+++\ntitle = "A"\n[params]\nx = 1\n+++\nbody', "tags", ["new"]);
    const json = parseFrontMatter('{"title": "A } B"}\nbody');
    return [
      yaml === '---\ntitle: A\ntags: ["new"]\nsummary: |\n  one\n  two\n---\nbody',
      parseFrontMatter(yaml).fields.summary === "one\ntwo",
      toml.indexOf("tags") < toml.indexOf("[params]"),
      json.kind === "json" && json.fields.title === "A } B",
    ];
  });
  check("front matter edits replace a field's whole value, in the right table", proof.frontMatter.every(Boolean), JSON.stringify(proof.frontMatter));

  // The status bar: each item is a plugin.
  proof.status = await until(() => /\d+ words · \d+ min read/.test(document.querySelector("footer").textContent) && /Grade/.test(document.querySelector("footer").textContent) && /broken link/.test(document.querySelector("footer").textContent));
  check("the status bar shows the word count, grade and link check, each from its own plugin", proof.status, (await footer()).replace(/\s+/g, " "));

  // Underlines: the readability plugin marks the long sentence, the link checker the missing page.
  const notes = () => page.evaluate(() => JSON.parse(document.querySelector("ui-editor")?.getAttribute("annotations") || "[]").map((n) => n.message));
  proof.underlined = await until(() => {
    const list = JSON.parse(document.querySelector("ui-editor")?.getAttribute("annotations") || "[]");
    return list.some((n) => /Long sentence/.test(n.message)) && list.some((n) => /\/nowhere\//.test(n.message));
  });
  check("plugins underline the post: a long sentence, a link to a page the site doesn't have", proof.underlined, (await notes()).join("; "));
  proof.drawn = await until(() => document.querySelector("ui-editor")?.shadowRoot?.querySelector(".cm-note"));
  check("the underlines are drawn in the editor", proof.drawn);

  // Typing goes through posts:change to every plugin.
  const words = async () => Number(((await footer()).match(/(\d[\d,]*) words ·/) ?? [])[1]?.replace(/,/g, ""));
  const before = await words();
  await page.click(`${editor} >> .cm-content`);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nThree more words.");
  proof.typed = await until((n) => Number((document.querySelector("footer").textContent.match(/(\d[\d,]*) words ·/) ?? [])[1]) === n + 3, before);
  check("typing updates the word count", proof.typed, `${before} → ${await words()}`);
  proof.unsaved = await until(() => document.querySelector('[data-key="posts:editor"] h2')?.textContent.includes("•"));
  check("an edit marks the post unsaved", proof.unsaved);

  // The outline is a panel; a heading jumps the editor there through document.select.
  await page.click('[data-key="outline:outline"] button >> text=Try it');
  proof.jumped = await until(() => {
    const el = document.querySelector("ui-editor");
    const [from, to] = (el?.getAttribute("select") ?? "").split(",").map(Number);
    return el && from === to && el.value.slice(from - 9, from) === "## Try it";
  });
  check("an outline heading puts the caret at that heading in the editor", proof.jumped, await page.getAttribute(editor, "select"));

  // The emoji picker puts an emoji in at the cursor through document.insert.
  await page.click('[data-key="emoji:button"] button');
  await page.waitForSelector('[data-key="emoji:emoji"] .grid button', { timeout: 5000 }).catch(() => {});
  const emoji = (await page.textContent('[data-key="emoji:emoji"] .grid button >> nth=0'))?.trim().split(/\s/)[0];
  await page.click('[data-key="emoji:emoji"] .grid button >> nth=0');
  proof.emoji = await until((e) => document.querySelector("ui-editor")?.value.includes(`## Try it${e}`), emoji);
  check("the emoji picker inserts an emoji at the caret", proof.emoji, emoji);

  // A paste comes to posts.js, runs through its posts:paste hook and goes in where the cursor is.
  await page.click(`${editor} >> .cm-content`);
  await page.keyboard.press("Control+End");
  await page.evaluate(() => {
    const target = document.querySelector("ui-editor").shadowRoot.querySelector(".cm-content");
    const data = new DataTransfer();
    data.setData("text/plain", "pasted words");
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  proof.pasted = await until(() => document.querySelector("ui-editor")?.value.trimEnd().endsWith("pasted words"));
  check("a paste goes through the posts plugin's paste hook into the post", proof.pasted, (await text()).slice(-40));

  // The tag suggester adds a tag to the front matter through document.setFrontMatter.
  await page.click('[data-key="tag-suggester:button"] button');
  const tagged = await page.waitForSelector('[data-key="tag-suggester:tags"]', { timeout: 5000 }).then(() => true, () => false);
  check("the Tags button opens the tag suggester", tagged);

  // Saving writes the file; the bullet goes and the post times say so. Save straight after typing
  // still has the last keystrokes: the editor sends them when it loses focus.
  await page.click(`${editor} >> .cm-content`);
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Last words.");
  await page.click('[data-key="posts:editor"] button >> text=Save');
  proof.saved = await until(() => !document.querySelector('[data-key="posts:editor"] h2')?.textContent.includes("•") && /Saved/.test(document.querySelector("footer").textContent));
  check("Save writes the post to the folder and the status bar says when", proof.saved, (await footer()).replace(/\s+/g, " "));
  proof.written = await page.evaluate(async () => {
    let dir = await navigator.storage.getDirectory();
    for (const part of [".folder", "content", "posts"]) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle("welcome.md")).getFile()).text();
  }).then((t) => t.includes("Three more words.") && t.includes("pasted words") && t.includes("Last words."), () => false);
  check("the saved file has what was typed and pasted, up to the last keystroke before Save", proof.written);
}
