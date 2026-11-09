// Outside agents: lets an agent in the browser (one built into it, such as
// Gemini in Chrome, or an extension) work on the post while you watch, through
// WebMCP. It does nothing itself: it opens the door, and the agent then acts as
// this plugin, with exactly the permissions below. Its tools are the writer
// agent's: read the post and the site's posts (document_read, document_list),
// edit it (document_applyEdits, document_insert, document_setFrontMatter),
// run the editor's reports and quick edits (commands_list, commands_run),
// read the site's files (folder_read, folder_list) and save (document_save).
// Its edits go into the editor like yours, so Undo takes them out, and the
// post reaches the disk only when it is saved. See docs/guide/outside-agents.md.

export const manifest = {
  id: "editor-agents",
  name: "Outside agents",
  description: "Lets an agent in your browser read and edit the open post with the writer's tools, through WebMCP.",
  version: "1.0.0",
  order: 175,
  permissions: ["outside", "commands", "document:read", "document:write", "folder:read"],
  services: ["outside", "tools", "document"],
};

export default async function (ctx) {
  await ctx.call("outside", "open", {
    instructions:
      "This is a Markdown editor for a Hugo site. document_read gives the open post: its whole text, front matter included, with the body starting at bodyStart. Change it with document_applyEdits, each edit's find copied exactly from that text and occurring once; set front matter fields with document_setFrontMatter. commands_list shows the editor's reports (readability, SEO, style guide, links, tags) and quick edits, which commands_run runs. Your edits show in the editor for the person to keep or undo; only save (document_save) when they ask you to.",
  });
}
