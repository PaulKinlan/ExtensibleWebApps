// Customize: a button in the corner of every app that opens a panel where
// the person changes the app for themselves. It has three tabs:
//
//   - Plugins: what is on this page (the app's own, the person's, the
//     space's), each with a switch, where it draws and a Move button; then
//     everything they can add, searchable, in three kinds: services (which
//     give the app something new other plugins use, such as a language
//     model), plugins that show on the page, and ones that work behind the
//     scenes. Signed in, it says what the person adds follows them to their
//     other devices, and marks what came from their account (std/follow).
//     A plugin that has just been added says so where it is listed,
//     with Turn on right there. The app's samples (each says what it adds),
//     and adding a plugin from files, pasted code or a URL, come last. A link
//     to the app that ends #add=<id> (the registry page's "Add to an app")
//     opens the panel and asks to add that plugin.
//   - Make: makes a new plugin of the person's own, in three steps: pick a
//     starter (std/customize.templates/), point at where it should show on
//     the page, then name it, change the code if they like, and save. Other
//     plugins can offer more ways to make one in the `customize.make` slot
//     (an agent that writes it from a description, say).
//   - Layout: where plugins can go on this page (its slots and the parts its
//     author named, and whether each is open, needs review or is locked), the
//     ui-* elements a view can use, and Arrange, which lets the person move
//     any plugin's view around the page (src/host/arrange.ts). Moves are kept
//     for this person and app (src/kernel/moves.ts).
//
// The host adds it to every app (src/host/main.ts), with a "customize" slot
// pinned to a corner. An app leaves it out with
// <meta name="customize" content="off">, and ?customize in the address
// brings it back.
//
// It is an ordinary sandboxed plugin, so it can't change anything on its
// own: every add, remove, save and share goes through the authoring service
// (src/kernel/authoring.ts), which shows the person a review card first.
// Turning plugins on or off, and moving them, needs no review.

export const manifest = {
  id: "customize",
  name: "Customize",
  description: "A Customize button that adds, makes, arranges, turns on and off, removes and shares plugins for an app.",
  version: "1.0.0",
  permissions: ["ui", "plugins:read", "plugins:author", "plugins:manage"],
  // Each tab's panel customizes the app open in that tab.
  scope: "tab",
  // The button is the kernel's until someone goes to it, and the rest of Customize is in the file beside this
  // one: an app pays for this manifest, and for nothing else of Customize's until its button is pressed.
  code: "customize.code.js",
  standIn: { slot: "customize", key: "panel", html: '<ui-panel label="Customize" toggle="panel" reopen="0"><p>Opening…</p></ui-panel>' },
};
