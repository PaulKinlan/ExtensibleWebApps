// Outside agents in a tab (std/outside/module.ts, src/host/bridges/webmcp.ts):
// the reading list's outside-agents.js opens the door, and a page-level WebMCP
// client sees the plugin's tools on document.modelContext, reads the library
// with them, and asks to change it, which the person reviews on the usual card.
// The client here is a stand-in for the browser's own, with the draft's
// registerTool / getTools / executeTool, installed before the page loads.
// (The space's MCP server is checked with the servers: tests/server/mcp.mjs.)

/** A stand-in for the browser's WebMCP, as the draft has it: tools come off when their signal aborts. */
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
      return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ execute, ...rest }) => rest);
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
    await page.goto(`${URL}demos/reading-list/app.html`);
    await page.waitForFunction(() => window.__host);
    let tools = [];
    for (let i = 0; i < 50 && !tools.some((t) => t.name === "data_put_library"); i++) {
      if (i) await page.waitForTimeout(200);
      tools = await page.evaluate(() => document.modelContext.getTools());
    }
    const names = tools.map((t) => t.name);
    check("a page-level WebMCP client sees the tools a plugin opened to outside agents", ["data_get_library", "data_list_library", "data_put_library"].every((n) => names.includes(n)), names.join(","));
    check(
      "the tools are only what the plugin's manifest grants: its collection, not the model or the tools service",
      !names.some((n) => /^(llm_|tools_|outside_|files_|net_)/.test(n)),
      names.join(","),
    );
    const put = tools.find((t) => t.name === "data_put_library");
    check(
      "each WebMCP tool has the collection's own fields, says whose it is, and whether it only reads",
      put?.inputSchema?.properties?.record?.properties?.shelf?.enum?.includes("to read") && /^Outside agent: /.test(put?.description ?? "") && put?.annotations?.readOnlyHint === false && tools.find((t) => t.name === "data_list_library")?.annotations?.readOnlyHint === true,
      JSON.stringify(put?.annotations),
    );

    const listed = await page.evaluate(() => document.modelContext.executeTool({ name: "data_list_library" }, {}));
    check("an outside agent reads the app's data with a WebMCP tool", JSON.parse(listed).some((b) => b.title === "Dune"), String(listed).slice(0, 120));

    // A change to the library, which isn't the door's plugin's own, waits for the person.
    const asked = page.evaluate(() =>
      document.modelContext.executeTool({ name: "data_put_library" }, { record: { title: "Kindred", author: "Octavia E. Butler", shelf: "to read" }, reason: "You said you wanted to read it" }).catch((e) => `error: ${e.message}`),
    );
    const card = page.locator('[data-key^="review:"]', { hasText: "Outside agent wants to change" });
    const shown = await card.waitFor({ timeout: 5000 }).then(() => true, () => false);
    check("an outside agent's change shows the person the usual review card, with its reason", shown && (await card.textContent()).includes("You said you wanted to read it"));
    await card.getByRole("button", { name: "Accept" }).click();
    const answer = await asked;
    const after = await page.evaluate(() => document.modelContext.executeTool({ name: "data_list_library" }, {}));
    check("once accepted, the change is made, and the agent hears it was", /"ok":true/.test(answer) && JSON.parse(after).some((b) => b.title === "Kindred"), answer);

    const declined = page.evaluate(() => document.modelContext.executeTool({ name: "data_delete_library" }, { id: "sample-dune", reason: "Tidying up" }).catch((e) => `error: ${e.message}`));
    await card.waitFor({ timeout: 5000 }).catch(() => {});
    await card.getByRole("button", { name: "Decline" }).click().catch(() => {});
    check("a declined change isn't made, and the agent's tool call fails saying so", /declined/.test(await declined), await declined);

    const wrong = await page.evaluate(() => window.__host.command("outside:call", { key: "not-a-key", name: "data_list_library", args: {} }));
    check("a tool call without the key this tab was given is refused", wrong?.ok === false, JSON.stringify(wrong));
  } finally {
    await page.close();
  }
}
