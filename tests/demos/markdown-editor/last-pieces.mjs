// The Markdown editor's last pieces (after #148): the on-device summarizer
// behind "Draft description", pictures saved next to a page bundle's
// index.md and Hugo's figure shortcode, and the Hugo preview hiding itself
// when its frame goes somewhere other than the post. Called from
// tests/demos/markdown-editor.mjs with the editor's page.

import { createServer } from "node:http";

export default async function lastPieces(page, { check, proof, text, until, editor }) {
  // The plugins' own logic, imported as modules (no eval in app pages).
  proof.lastHelpers = await page.evaluate(async () => {
    const { proseOnly, draftFor } = await import("/demos/markdown-editor/front-matter.js");
    const { placeFor, imageText, isBundle } = await import("/demos/markdown-editor/images.js");
    const bundle = { path: "content/posts/trip/index.md", frontMatter: {} };
    const single = { path: "content/posts/hello.md", frontMatter: {} };
    const inBundle = placeFor(bundle);
    const toStatic = placeFor(bundle, "Always in static/images/");
    return [
      proseOnly("Hello [there](https://x.example).\n\n```js\ncode()\n```\n{{< figure src=\"a.png\" >}}\n![alt](a.png) <b>bold</b>") === "Hello there.\n\n bold",
      draftFor("description", "Site").kind === "teaser" && draftFor("summary", "Site").kind === "tldr" && /blog "Site"/.test(draftFor("summary", "Site").context),
      isBundle(bundle) && !isBundle(single) && isBundle({ path: "content/docs/_index.md" }) && !isBundle({ path: "content/index.md" }),
      inBundle.dir === "content/posts/trip" && inBundle.link("content/posts/trip/shot.png") === "shot.png",
      toStatic.dir === "static/images/trip" && toStatic.link("static/images/trip/shot.png") === "/images/trip/shot.png",
      placeFor(single).dir === "static/images/hello",
      imageText("shot.png", "shot") === "![shot](shot.png)" && imageText("/images/a b.png", "a") === "![a](</images/a b.png>)",
      imageText("shot.png", 'a "b"', "Hugo's figure shortcode") === '{{< figure src="shot.png" alt="a \'b\'" caption="" >}}',
    ];
  });
  check("the last pieces' helpers: a summary's prose and kind, a picture's place and link, Hugo's figure", proof.lastHelpers.every(Boolean), JSON.stringify(proof.lastHelpers));

  // "Draft description": the description field has a Draft button that drafts it with the browser's on-device
  // summarizer, from the post's prose. Headless Chromium has none, so a stand-in Summarizer takes its place;
  // the <ui-summarizer> element is the real one.
  const form = '[data-key="front-matter:form"]';
  const field = `${form} .long ui-summarizer[action="draft:description"]`;
  const offer = `${form} ui-summarizer[action="draft:description"]:not(.long *)`;
  proof.draftButton = await page.waitForSelector(field, { state: "attached", timeout: 5000 }).then(() => true, () => false);
  proof.draftSource = await page.evaluate((sel) => document.querySelector(sel)?.textContent ?? "", field);
  check("the description field has a Draft button, fed the post's prose without its front matter", proof.draftButton && /Every part of this editor is a plugin/.test(proof.draftSource) && !proof.draftSource.includes("title:"), proof.draftSource.slice(0, 60));
  // With no description, the form offers to draft one.
  await page.click(`${form} button[data-action="remove:description"]`);
  proof.draftOffered = await page.waitForSelector(offer, { state: "attached", timeout: 5000 }).then(() => true, () => false);
  proof.drafted = await page.evaluate(async (sel) => {
    const asked = [];
    window.Summarizer = {
      async create(options) {
        asked.push(options);
        return { summarize: async (input) => `A short teaser of ${input.split(/\s+/).length} words.`, destroy() {} };
      },
    };
    await document.querySelector(sel)?.draft();
    return asked;
  }, offer);
  proof.description = await until(() => /\ndescription: "?A short teaser of \d+ words\."?\n/.test(document.querySelector("ui-editor")?.value ?? ""));
  check("with no description, Draft a description puts the summarizer's teaser into the front matter", proof.draftOffered && proof.description && proof.drafted[0]?.type === "teaser" && proof.drafted[0]?.format === "plain-text", (await text()).slice(0, 200));
  await page.waitForSelector(field, { state: "attached", timeout: 5000 }).catch(() => {});
  await page.evaluate((sel) => {
    window.Summarizer = { async create() { throw new DOMException("No model", "NotSupportedError"); } };
    return document.querySelector(sel)?.draft();
  }, field);
  proof.draftError = await until((sel) => /can't handle this text/.test(document.querySelector(`${sel} .problem`)?.textContent ?? ""), form);
  check("the form says why when the summarizer can't draft", proof.draftError);
  await page.evaluate(() => delete window.Summarizer);
  // Saved, so opening another post leaves nothing behind.
  await page.click('[data-key="posts:editor"] button[data-action="save"]');
  await until(() => !document.querySelector('[data-key="posts:editor"] h2')?.textContent.includes("•"));

  // A page bundle: a picture pasted on content/posts/trip/index.md is saved next to it, and linked by its name.
  await page.evaluate(async () => {
    let dir = await navigator.storage.getDirectory();
    for (const part of [".folders", "demos~markdown-editor", "content", "posts", "trip"]) dir = await dir.getDirectoryHandle(part, { create: true });
    const out = await (await dir.getFileHandle("index.md", { create: true })).createWritable();
    await out.write("---\ntitle: A trip\n---\n\nWhere we went.\n");
    await out.close();
    document.querySelector('[data-key="posts:files"] .files').dispatchEvent(new CustomEvent("ui-action", { bubbles: true, composed: true, detail: { action: "rescan" } }));
  });
  const trip = '[data-key="posts:files"] button[data-action="open:content/posts/trip/index.md"]';
  proof.tripListed = await page.waitForSelector(trip, { timeout: 8000 }).then(() => true, () => false);
  if (proof.tripListed) await page.click(trip);
  proof.tripOpen = await until(() => (document.querySelector("ui-editor")?.value ?? "").includes("Where we went."));
  check("a page bundle's index.md is listed and opens", proof.tripListed && proof.tripOpen);
  const pasteImage = () =>
    page.evaluate(async () => {
      const png = await (await fetch("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")).blob();
      const target = document.querySelector("ui-editor").shadowRoot.querySelector(".cm-content");
      const data = new DataTransfer();
      data.items.add(new File([png], "Beach.png", { type: "image/png" }));
      target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
  await page.click(`${editor} >> .cm-content`);
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(400);
  await pasteImage();
  proof.bundleImage = await until(() => (document.querySelector("ui-editor")?.value ?? "").includes("![beach](beach.png)"));
  proof.bundleFile = await page
    .evaluate(async () => {
      let dir = await navigator.storage.getDirectory();
      for (const part of [".folders", "demos~markdown-editor", "content", "posts", "trip"]) dir = await dir.getDirectoryHandle(part);
      return (await (await dir.getFileHandle("beach.png")).getFile()).size === 70;
    })
    .catch(() => false);
  check("a picture pasted on a page bundle is saved next to its index.md and linked by its name", proof.bundleImage && proof.bundleFile, (await text()).slice(-60));

  // The Hugo preview: a stand-in server on this device whose post page sends the frame on elsewhere.
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url?.startsWith("/posts/trip/")) return res.end('<!doctype html><title>Trip</title><p>The trip</p><script>setTimeout(() => (location.href = "/elsewhere/"), 300)</script>');
    res.end("<!doctype html><title>Somewhere</title><p>Somewhere else</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const panel = '[data-key="hugo-preview:preview"]';
    await page.click('[data-key="hugo-preview:button"] button');
    await page.waitForSelector(`${panel} input[name="origin"]`, { timeout: 5000 });
    await page.fill(`${panel} input[name="origin"]`, `127.0.0.1:${port}`);
    await page.click(`${panel} form button[type="submit"]`);
    proof.previewAddress = await until((p) => document.querySelector('[data-key="hugo-preview:preview"] ui-site-preview')?.getAttribute("address") === `http://127.0.0.1:${p}/posts/trip/`, port);
    proof.previewLeft = await until(() => {
      const root = document.querySelector('[data-key="hugo-preview:preview"] ui-site-preview')?.shadowRoot;
      return !!root && root.querySelector("iframe").hidden && /went to another page/.test(root.querySelector(".none")?.textContent ?? "") && !root.querySelector(".back").hidden;
    }, undefined, 10000);
    check("the Hugo preview hides its frame when the page in it goes somewhere other than the post", proof.previewAddress && proof.previewLeft);
    await page.click('[data-key="hugo-preview:button"] button');
  } finally {
    server.close();
  }
}
