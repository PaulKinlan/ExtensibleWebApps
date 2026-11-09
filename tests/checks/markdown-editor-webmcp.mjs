// The Markdown editor's writer tools on WebMCP: its editor-agents.js opens the
// door (std/outside/module.ts), so an agent in the browser finds the writer's
// tools on document.modelContext, reads the open post with them and edits it.
// The edit goes into the editor, unsaved, as the writer agent's do. The client
// is a stand-in for the browser's own, installed before the page loads, as in
// outside-agents.mjs.

const webmcp = () => {
  const tools = new Map();
  document.modelContext = {
    registerTool(tool, { signal } = {}) {
      if (!tool.name || !tool.description || typeof tool.execute !== "function") throw new TypeError("Not a tool");
      if (tools.has(tool.name)) throw new DOMException(`${tool.name} is registered already`, "InvalidStateError");
      tools.set(tool.name, tool);
      signal?.addEventListener("abort", () => tools.delete(tool.name));
    },
    async getTools() {
      return [...tools.values()].map(({ execute, ...rest }) => rest);
    },
    async executeTool(tool, input) {
      const found = tools.get(tool.name);
      if (!found) throw new DOMException("No such tool", "NotFoundError");
      return found.execute(input, { signal: new AbortController().signal });
    },
  };
};

export default async function ({ check, context, URL }) {
  const page = await context.newPage();
  await page.addInitScript(webmcp);
  try {
    await page.goto(`${URL}demos/markdown-editor/app.html`);
    await page.waitForFunction(() => window.__host);
    let names = [];
    for (let i = 0; i < 50 && !names.includes("document_applyEdits"); i++) {
      if (i) await page.waitForTimeout(200);
      names = (await page.evaluate(() => document.modelContext.getTools())).map((t) => t.name);
    }
    check(
      "the Markdown editor offers the writer's tools to an agent in the browser, through WebMCP",
      ["document_read", "document_list", "document_applyEdits", "document_setFrontMatter", "commands_list", "commands_run", "folder_read"].every((n) => names.includes(n)) && !names.some((n) => /^(llm_|tools_|folder_write|folder_choose)/.test(n)),
      names.join(","),
    );
    await page.waitForFunction(() => document.querySelector("ui-editor")?.value, null, { timeout: 8000 });
    const post = JSON.parse(await page.evaluate(() => document.modelContext.executeTool({ name: "document_read" }, {})));
    check("an outside agent reads the open post", typeof post?.text === "string" && post.text.length > 0 && typeof post.bodyStart === "number", post?.title);
    const find = post.text.slice(post.bodyStart).match(/[^\n]{12,}/)?.[0] ?? "";
    const answer = await page.evaluate((f) => document.modelContext.executeTool({ name: "document_applyEdits" }, { edits: [{ find: f, replace: `${f} (edited from outside)` }] }), find);
    const edited = await page.waitForFunction(() => document.querySelector("ui-editor")?.value.includes("(edited from outside)"), null, { timeout: 5000 }).then(() => true, () => false);
    const unsaved = await page.waitForFunction(() => document.querySelector('[data-key="posts:editor"] h2')?.textContent.includes("•"), null, { timeout: 5000 }).then(() => true, () => false);
    check("its edit goes into the editor, unsaved, for the person to keep or undo", edited && unsaved && /"applied":1/.test(answer), answer);
    // Back as it was, so the demo's own checks start from the sample post.
    await page.evaluate((f) => document.modelContext.executeTool({ name: "document_applyEdits" }, { edits: [{ find: `${f} (edited from outside)`, replace: f }] }), find);
  } finally {
    await page.close();
  }
}
