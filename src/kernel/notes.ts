// The notes app: a trusted plugin in the kernel worker that draws its UI as
// declarative views and turns the person's actions into hooks other plugins
// can listen to. Its events match the Markdown editor's post events, so the
// editor's extensions run against it through the shim in the sandbox.

import type { Hosts } from "./hosts";
import type { Note, Store } from "./store";
import type { Dispatch } from "../shared/protocol";

export function notesApp(ctx: any, store: Store, hosts: Hosts) {
  let openId: string | undefined;
  let draft = "";
  let status = "";
  /** The draft has edits the person hasn't saved (also after a save was refused). */
  let dirty = false;

  const snapshot = (unsaved: boolean) => {
    const note = openId ? store.get(openId) : undefined;
    return note
      ? { path: `notes/${note.id}.md`, url: `/notes/${note.id}/`, title: note.title, siteName: "Notes", text: draft, bodyStart: 0, selection: { from: 0, to: 0 }, unsaved }
      : null;
  };

  const titleOf = (text: string) => text.split("\n")[0].replace(/^#+\s*/, "").trim().slice(0, 60) || "Untitled";

  const render = () => {
    hosts.render("notes", "app.nav", "notes:list", {
      type: "stack",
      children: [
        { type: "heading", text: "Notes" },
        { type: "button", label: "New note", action: "new", primary: true },
        { type: "list", items: store.list().map((n) => ({ label: n.title, action: `open:${n.id}`, selected: n.id === openId })) },
      ],
    }, 10);
    hosts.render("notes", "app.main", "notes:editor", openId
      ? {
          type: "stack",
          children: [
            { type: "textarea", name: "text", value: draft, action: "edit", placeholder: "Write something" },
            { type: "stack", direction: "row", children: [
              { type: "button", label: "Save", action: "save", primary: true },
              { type: "text", text: status, tone: status.startsWith("Not saved") ? "error" : "muted" },
            ] },
          ],
        }
      : { type: "text", text: "Pick a note, or make a new one.", tone: "muted" }, 10);
  };

  const open = (id: string, d: Dispatch) => {
    if (openId) ctx.emit(d, "note:close", null);
    openId = id;
    draft = store.get(id)?.text ?? "";
    status = "";
    dirty = false;
    render();
    ctx.emit(d, "note:open", snapshot(false));
  };

  const save = async (d: Dispatch) => {
    const note = openId ? store.get(openId) : undefined;
    if (!note) return;
    const next: Note = { ...note, text: draft, title: titleOf(draft), updated: Date.now() };
    const result = await store.put(next, d);
    status = result.ok ? "Saved" : `Not saved: ${result.reason}`;
    if (result.ok) dirty = false;
    render();
    if (result.ok) ctx.emit(d, "note:save", snapshot(false));
  };

  const handle = async (action: string, value: unknown, d: Dispatch) => {
    if (action === "new") {
      const id = Math.random().toString(36).slice(2, 8);
      await store.put({ id, title: "Untitled", text: "", updated: Date.now() }, d);
      return open(id, d);
    }
    if (action.startsWith("open:")) return open(action.slice(5), d);
    if (action === "edit") {
      draft = String(value ?? "");
      status = "Unsaved changes";
      dirty = true;
      ctx.emit(d, "note:change", snapshot(true));
      return;
    }
    if (action === "save") return save(d);
  };

  // A note can also change from elsewhere: a plugin's reviewed write. Show
  // it, unless the person has unsaved edits of their own.
  ctx.on("data:changed", function (this: Dispatch | null, change: { id: string; after: Note }) {
    if (change.id === openId && !dirty && draft !== change.after.text) {
      draft = change.after.text;
      status = "Changed by a plugin";
      render();
      // Tell note listeners (word count, the editor shim) what the note now says.
      ctx.emit(this ?? {}, "note:save", snapshot(false));
      return;
    }
    render();
  });

  return {
    async start() {
      await store.ready;
      if (!store.list().length) {
        await store.put({ id: "welcome", title: "Welcome", text: "Welcome\n\nEvery feature you see here is a plugin running in a worker.", updated: Date.now() });
      }
      render();
    },
    event(action: string, value: unknown, trace: string) {
      return handle(action, value, { trace });
    },
    get openId() {
      return openId;
    },
  };
}
