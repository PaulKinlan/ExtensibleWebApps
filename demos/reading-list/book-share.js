// Book share: a page shared to the reading list from the browser, or from any
// app, becomes a book to read. Install the reading list from the browser
// (it has a manifest.webmanifest with a share_target), then share a page to
// it: the page's title is the book, its link goes in the notes.
//
// The share service keeps what was shared until a plugin takes it; this one
// takes it when it starts (the share may have opened the app) and whenever
// another arrives. The library isn't its own, so the person reviews each book
// before it is added, as with book-import.js.

export const manifest = {
  id: "book-share",
  name: "Book share",
  description: "Adds a page shared to the reading list as a book to read, with its link in the notes.",
  version: "1.0.0",
  permissions: ["share", "data:write:library"],
};

export default async function (ctx) {
  async function receive() {
    const shared = await ctx.call("share", "take");
    if (!shared) return;
    // Some apps put the link in the text, and some send no title.
    const title = (shared.title || shared.text?.split("\n")[0] || shared.url).slice(0, 200);
    const notes = [shared.text !== title ? shared.text : "", shared.url].filter(Boolean).join("\n");
    await ctx.call("data", "put", "library", { title, shelf: "to read", ...(notes ? { notes } : {}) }, `Add “${title}”, shared from another app`).catch((error) => ctx.log(`Not added: ${error.message}`));
  }
  ctx.on("share:received", receive);
  await receive();
}
