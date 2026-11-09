// The shorthand for opening an app to outside agents: an agent file with
// `outside: true` (src/kernel/agents/file.ts) instead of a plugin that calls
// outside.open. Here the reading list is served linking one in place of its
// outside-agents.js (no service worker, so the page's own requests can be
// rewritten), and a page-level WebMCP client sees the door's tools. A file
// that asks for a model or a loop is refused. (On a space's server, the same
// file opens the MCP door: tests/server/mcp-more.mjs.)
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** The kernel's own reader of agent files, bundled from src/ as scripts/check.mjs does. */
async function kernelFile() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const out = await build({ stdin: { contents: 'export { fromAgentFile } from "./src/kernel/agents/file.ts";', resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}

const DOOR = `---
id: shelf-agents
name: Shelf helper
outside: true
permissions: [data:read:library]
---
This is a reading list. Read the library to answer questions about it.
`;

/** A stand-in for the browser's WebMCP, as tests/checks/outside-agents.mjs has it. */
const webmcp = () => {
  const tools = new Map();
  document.modelContext = {
    registerTool(tool, { signal } = {}) {
      tools.set(tool.name, tool);
      signal?.addEventListener("abort", () => tools.delete(tool.name));
    },
    async getTools() {
      return [...tools.values()].map(({ execute, ...rest }) => rest);
    },
    async executeTool(tool, input) {
      return tools.get(tool.name).execute(input, { signal: new AbortController().signal });
    },
  };
};

export default async function ({ check, context, URL }) {
  const { fromAgentFile } = await kernelFile();
  const source = fromAgentFile(DOOR);
  const manifest = JSON.parse(/export const manifest = (\{[\s\S]*?\n\});/.exec(source)?.[1] ?? "{}");
  check(
    "an outside agent file becomes the door's plugin: it runs in the browser and on a space's server, with its permissions and outside",
    manifest.runs === "both" && manifest.permissions.includes("outside") && manifest.permissions.includes("data:read:library") && !manifest.permissions.includes("llm") && /ctx\.call\("outside", "open"/.test(source),
    JSON.stringify(manifest),
  );
  const refused = (() => {
    try {
      fromAgentFile(DOOR.replace("outside: true\n", "outside: true\nmodel: fast\n"));
      return "";
    } catch (error) {
      return error.message;
    }
  })();
  check("an outside agent file that names a model is refused: the agent brings its own", /has no `model`/.test(refused), refused);

  const own = await context.browser().newContext({ serviceWorkers: "block" });
  try {
    await own.route(`${URL}demos/reading-list/app.html`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('<link rel="plugin" href="outside-agents.js">', '<link rel="agent" href="shelf.agent.md">') });
    });
    await own.route(`${URL}demos/reading-list/shelf.agent.md`, (route) => route.fulfill({ contentType: "text/markdown", body: DOOR }));
    const page = await own.newPage();
    await page.addInitScript(webmcp);
    await page.goto(`${URL}demos/reading-list/app.html`);
    await page.waitForFunction(() => window.__host);
    let tools = [];
    for (let i = 0; i < 50 && !tools.some((t) => t.name === "data_list_library"); i++) {
      if (i) await page.waitForTimeout(200);
      tools = await page.evaluate(() => document.modelContext.getTools());
    }
    const names = tools.map((t) => t.name);
    const list = tools.find((t) => t.name === "data_list_library");
    check(
      "an app opens the door with an outside agent file alone: a WebMCP client sees the tools its permissions grant, and what the app is for",
      !!list && !names.includes("data_put_library") && /This is a reading list/.test(list.description ?? "") && /^Shelf helper: /.test(list.description ?? ""),
      JSON.stringify(tools.map((t) => [t.name, t.description])),
    );
    const listed = await page.evaluate(() => document.modelContext.executeTool({ name: "data_list_library" }, {}));
    check("an outside agent reads the app's data through the door the file opened", JSON.parse(listed).some((b) => b.title === "Dune"), String(listed).slice(0, 120));
  } finally {
    await own.close();
  }
}
