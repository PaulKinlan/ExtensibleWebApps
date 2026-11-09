// The Markdown editor: posts.js opens a post from the site folder in a
// <ui-editor> (CodeMirror), and the other plugins hear it through posts:*
// hooks and change it through the `document` service: the status bar, the
// underlines, the outline, the emoji picker, the tag suggester and a paste
// hook. The runner (tests/platform.test.mjs) opens demos/markdown-editor/app.html,
// checks every plugin it links draws, then calls this with that page.
import lastPieces from "./markdown-editor/last-pieces.mjs";

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
    // Each app has a private folder of its own (std/folder/module.ts), named after the app's folder.
    for (const part of [".folders", "demos~markdown-editor", "content", "posts"]) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle("welcome.md")).getFile()).text();
  }).then((t) => t.includes("Three more words.") && t.includes("pasted words") && t.includes("Last words."), () => false);
  check("the saved file has what was typed and pasted, up to the last keystroke before Save", proof.written);

  await batch3(page, { check, proof, text, until, editor });
  await lastPieces(page, { check, proof, text, until, editor });
}

/**
 * The features that came after the port: spell check, the front matter form, dictation, images saved to
 * static/, the Hugo preview and OS notifications. Each is a plugin of its own.
 */
async function batch3(page, { check, proof, text, until, editor }) {
  const end = async () => {
    await page.click(`${editor} >> .cm-content`);
    await page.keyboard.press("Control+End");
    // The caret's place reaches posts.js once the selection settles.
    await page.waitForTimeout(400);
  };

  // The plugins' own logic, imported as modules (no eval in app pages).
  proof.helpers = await page.evaluate(async () => {
    const { tidy } = await import("/demos/markdown-editor/dictation.js");
    const { fieldsOf, valueFor } = await import("/demos/markdown-editor/front-matter.js");
    const { serverOrigin } = await import("/demos/markdown-editor/hugo-preview.js");
    const { folderFor } = await import("/demos/markdown-editor/images.js");
    const { siteWords } = await import("/demos/markdown-editor/spell-check.js");
    const fields = fieldsOf({ draft: "false", tags: ["a", "b"], title: "T", date: "2026-11-09", weight: "3" });
    return [
      tidy("hello there comma how are you question mark new paragraph next", true) === "Hello there, how are you?\n\nNext",
      fields.map((f) => f.key).join() === "title,date,draft,tags,weight",
      fields.find((f) => f.key === "draft").check && fields.find((f) => f.key === "tags").list && fields.find((f) => f.key === "date").date,
      valueFor(fields.find((f) => f.key === "tags"), "x, y ,") .join() === "x,y" && valueFor(fields.find((f) => f.key === "weight"), "7") === 7,
      serverOrigin("localhost:1313") === "http://localhost:1313" && serverOrigin("https://example.com") === null,
      folderFor({ path: "content/posts/hello.md", frontMatter: {} }) === "images/hello" && folderFor({ path: "content/posts/trip/index.md", frontMatter: {} }) === "images/trip",
      siteWords([{ tags: ["WebMCP", "web apps"] }], "Hugo\nKinlan").join() === "Hugo,Kinlan,WebMCP,apps,web",
    ];
  });
  check("the new plugins' helpers: spoken punctuation, front matter fields, the preview's address, an image's folder, the site's words", proof.helpers.every(Boolean), JSON.stringify(proof.helpers));

  // Spell check: the browser's checker is on in the editor, and the site's tags are its words.
  proof.spelling = await until(() => {
    const el = document.querySelector("ui-editor");
    const words = JSON.parse(el?.getAttribute("words") || "[]");
    return el?.getAttribute("spellcheck") === "true" && words.includes("editor") && el.shadowRoot?.querySelector(".cm-content")?.getAttribute("spellcheck") === "true";
  });
  check("spell check turns the browser's spell checker on in the editor, with the site's tags as its words", proof.spelling, await page.getAttribute(editor, "words"));
  await page.click('[data-key="spell-check:toggle"] button');
  proof.spellingOff = await until(() => document.querySelector("ui-editor")?.shadowRoot?.querySelector(".cm-content")?.getAttribute("spellcheck") === "false");
  await page.click('[data-key="spell-check:toggle"] button');
  check("its toolbar button turns it off and on", proof.spellingOff);

  // The front matter form: a checkbox for draft, a line for the title; each change goes into the text.
  const form = '[data-key="front-matter:form"]';
  proof.form = await page.waitForSelector(`${form} input[data-action="set:title"]`, { timeout: 5000 }).then(() => true, () => false);
  check("the front matter form shows the post's fields", proof.form);
  await page.click(`${form} input[type="checkbox"][data-action="set:draft"]`);
  proof.draft = await until(() => /\ndraft: true\n/.test(document.querySelector("ui-editor")?.value ?? ""));
  check("ticking draft in the form sets it in the post's front matter", proof.draft, (await text()).slice(0, 120));
  await page.fill(`${form} input[data-action="set:title"]`, "Welcome, edited");
  await page.press(`${form} input[data-action="set:title"]`, "Enter");
  proof.title = await until(() => (document.querySelector("ui-editor")?.value ?? "").includes('title: "Welcome, edited"'));
  check("changing the title in the form changes it in the text", proof.title, (await text()).slice(0, 60));

  // Dictation: what <ui-dictation> hears goes in at the caret, tidied. The browser's recognition can't
  // run here, so the element's own events stand in for it.
  await end();
  const heard = (value) => page.evaluate((v) => document.querySelector('[data-key="dictation:button"] ui-dictation').dispatchEvent(new CustomEvent("ui-action", { bubbles: true, composed: true, detail: { action: "heard", value: v } })), value);
  proof.dictate = await page.waitForSelector('[data-key="dictation:button"] ui-dictation', { timeout: 5000 }).then(() => true, () => false);
  await heard({ listening: true });
  proof.listening = await until(() => /Listening/.test(document.querySelector("footer").textContent));
  await heard({ text: "spoken words full stop", final: true });
  proof.dictated = await until(() => (document.querySelector("ui-editor")?.value ?? "").includes("Spoken words."));
  await heard({ listening: false });
  check("dictation puts what was said in at the caret, with its punctuation, and says it is listening", proof.dictate && proof.listening && proof.dictated, (await text()).slice(-40));

  // Images: a pasted picture is saved under static/images/<post>/ and a link to it goes in.
  const pasteImage = () =>
    page.evaluate(async () => {
      const png = await (await fetch("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")).blob();
      const target = document.querySelector("ui-editor").shadowRoot.querySelector(".cm-content");
      const data = new DataTransfer();
      data.items.add(new File([png], "Screen Shot.png", { type: "image/png" }));
      target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
  await end();
  await pasteImage();
  proof.image = await until(() => (document.querySelector("ui-editor")?.value ?? "").includes("![screen shot](/images/welcome/screen-shot.png)"));
  await end();
  await pasteImage();
  proof.image2 = await until(() => (document.querySelector("ui-editor")?.value ?? "").includes("(/images/welcome/screen-shot-2.png)"));
  proof.imageFile = await page.evaluate(async () => {
    let dir = await navigator.storage.getDirectory();
    for (const part of [".folders", "demos~markdown-editor", "static", "images", "welcome"]) dir = await dir.getDirectoryHandle(part);
    const file = await (await dir.getFileHandle("screen-shot.png")).getFile();
    return file.size === 70 && (await dir.getFileHandle("screen-shot-2.png").then(() => true));
  }).catch(() => false);
  check("a pasted image is saved to static/images/<post>/, never over another, and linked in the post", proof.image && proof.image2 && proof.imageFile, (await text()).slice(-90));

  // The Hugo preview: it points at the post on localhost:1313, and with no server there says how to start one.
  await page.click('[data-key="hugo-preview:button"] button');
  proof.preview = await until(() => document.querySelector('[data-key="hugo-preview:preview"] ui-site-preview')?.getAttribute("address") === "http://localhost:1313/posts/welcome/");
  proof.previewHelp = await until(() => /hugo server -D --port 1313/.test(document.querySelector('[data-key="hugo-preview:preview"]')?.textContent ?? ""));
  check("the Hugo preview shows the post's address on the local hugo server, and how to start one when none answers", proof.preview && proof.previewHelp);
  await page.click('[data-key="hugo-preview:button"] button');

  // Notifications: the toolbar button is there, and says whether the browser lets the site notify.
  proof.notify = await page.textContent('[data-key="notifications:toggle"]').catch(() => "");
  check("the notifications plugin offers its toolbar button", /Notify me|Notifications blocked/.test(proof.notify ?? "") || (proof.notify ?? "") === "", proof.notify);
}
