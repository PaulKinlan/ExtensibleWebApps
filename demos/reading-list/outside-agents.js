// Outside agents: lets an agent that isn't part of the app (the browser's
// own assistant, or Claude Code and other MCP clients) look after the
// reading list. It does nothing itself: it opens the door, and an outside
// agent then acts as this plugin, with exactly the permissions below.
//
// - On this page, its tools are WebMCP tools (document.modelContext), for an
//   agent in the browser to find.
// - Opened in a space, the space's server offers the same tools over MCP at
//   /s/<space>/mcp/reading-list-agents, for a member's agent with a key from
//   /account/.
//
// It may read the library and change it, but the library is library.js's,
// so the person reviews every change an outside agent asks for, on the same
// card as any plugin's. See docs/guide/outside-agents.md.

export const manifest = {
  id: "reading-list-agents",
  name: "Outside agent",
  description: "Lets agents outside the app read the reading list and suggest changes, which you review.",
  version: "1.0.0",
  runs: "both",
  permissions: ["outside", "data:read:library", "data:write:library"],
  services: ["outside", "tools"],
};

export default async function (ctx) {
  await ctx.call("outside", "open", {
    instructions:
      "This is a reading list. Each book in the library has a title, an author, a year, a shelf (to read, reading or done) and, if it is borrowed, the date it is due back. Read the library before changing it. Every change you make is shown to the person to accept or decline, so give a short reason with each one.",
  });
}
