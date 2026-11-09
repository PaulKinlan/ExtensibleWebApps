// Book files: an ebook opened with the reading list becomes a book to read.
// Install the reading list from the browser (its manifest.webmanifest has
// file_handlers for .pdf and .epub), then open a book's file with it from
// your files: its name, tidied, is the title, and the file's name goes in the
// notes so you can find it again.
//
// The launch service keeps the opened files until a plugin takes them; this
// one takes them when it starts (opening the file may have opened the app)
// and whenever more arrive. The library isn't its own, so the person reviews
// each book before it is added, as with book-share.js.

export const manifest = {
  id: "book-files",
  name: "Book files",
  description: "Adds an ebook (.pdf or .epub) opened with the reading list as a book to read.",
  version: "1.0.0",
  permissions: ["launch", "data:write:library"],
  services: ["launch"],
};

/** "a-memory_called_empire.epub" → "a memory called empire". */
const titleOf = (name) => name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

export default async function (ctx) {
  async function receive() {
    for (const file of await ctx.call("launch", "take")) {
      // The manifest asks for ebooks only, but a file is only a book if it is one.
      if (!/\.(pdf|epub)$/i.test(file.name)) continue;
      const title = titleOf(file.name) || file.name;
      await ctx.call("data", "put", "library", { title, shelf: "to read", notes: `File: ${file.name}` }, `Add “${title}”, opened from your files`).catch((error) => ctx.log(`Not added: ${error.message}`));
    }
  }
  ctx.on("launch:received", receive);
  await receive();
}
