// The notes app, as a plugin: a list of notes and an editor, kept in its own
// `notes` collection. It turns what the person does into hooks of its own
// (notes:open, notes:change, notes:save, notes:close, notes:selection), which
// other plugins listen to, and which the Markdown editor's extensions hear as
// post events through the shim in the sandbox. A paste or a drop goes through
// notes:paste and notes:drop first, so a plugin can change what goes in (a
// link pasted onto a word becomes a Markdown link). Only the workbench links it.

export const manifest = {
  id: "notes",
  name: "Notes",
  description: "Notes you can open, edit and save. Other plugins hear what you do through its hooks.",
  version: "1.0.0",
  permissions: ["ui"],
  order: 10,
  collections: {
    notes: {
      title: "Notes",
      schema: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 60 },
          text: { type: "string", maxLength: 100000 },
        },
      },
    },
  },
  hooks: {
    open: { mode: "emit", args: "{ id, path, url, title, siteName, text, bodyStart, selection, unsaved }", description: "The person opened a note." },
    change: { mode: "emit", args: "{ id, path, url, title, siteName, text, bodyStart, selection, unsaved }", description: "The person typed in the open note (unsaved is true)." },
    save: { mode: "emit", args: "{ id, path, url, title, siteName, text, bodyStart, selection, unsaved }", description: "The open note was saved, by the person or by another plugin's reviewed write." },
    close: { mode: "emit", args: "null", description: "The open note was closed." },
    selection: { mode: "emit", args: "{ from, to, text }", description: "The selection in the open note settled: offsets into its text, and the text selected." },
    paste: {
      mode: "waterfall",
      timeoutMs: 2000,
      args: "{ from, to, text, html, files, selected }",
      description: "The person pasted into the open note, replacing from..to (the text `selected`). Return { text } to put in something else, or { block } to paste nothing. files are { name, type, size, text?, dataUrl? }.",
    },
    drop: {
      mode: "waterfall",
      timeoutMs: 2000,
      args: "{ from, to, text, html, files, selected }",
      description: "The person dropped text or files onto the open note, at from..to. Return { text } to put in something else, or { block } to drop nothing. A text file's text goes in if nothing else does.",
    },
  },
};

const WELCOME = "Welcome\n\nEvery feature you see here is a plugin running in a worker.";
const titleOf = (text) => text.split("\n")[0].replace(/^#+\s*/, "").trim().slice(0, 60) || "Untitled";

export default async function (ctx) {
  let notes = [];
  let openId;
  let draft = "";
  let status = "";
  /** The draft has edits the person hasn't saved (also after a save was refused). */
  let dirty = false;
  /** Counts the person's edits, so a save that comes back after a newer edit doesn't mark that edit saved. */
  let revision = 0;
  /** The selection in the open note, as offsets into its text. */
  let selection = { from: 0, to: 0 };

  const list = async (api = ctx) => (notes = await api.call("data", "list", "notes"));
  /**
   * The open note and its draft, kept in the plugin's own storage: this one worker serves every tab, and
   * it starts again in another tab when the tab it ran in closes, so a draft mustn't live only in memory.
   */
  const remember = (api) => api.storage.set("open", openId ? { id: openId, draft, dirty } : null);
  const find = (id) => notes.find((n) => n.id === id);

  /** What a note's hooks carry: the Markdown editor's post, for its extensions. */
  const snapshot = (unsaved) => {
    const note = openId && find(openId);
    return note ? { id: note.id, path: `notes/${note.id}.md`, url: `/notes/${note.id}/`, title: note.title ?? "Untitled", siteName: "Notes", text: draft, bodyStart: 0, selection, unsaved } : null;
  };

  const render = (api = ctx) => {
    api.ui.render("nav", "list", {
      type: "stack",
      children: [
        { type: "heading", text: "Notes" },
        { type: "button", label: "New note", action: "new", primary: true },
        { type: "list", items: notes.map((n) => ({ label: n.title ?? "Untitled", action: `open:${n.id}`, selected: n.id === openId })) },
      ],
    });
    api.ui.render(
      "main",
      "editor",
      openId
        ? {
            type: "stack",
            children: [
              { type: "textarea", name: "text", value: draft, action: "edit", placeholder: "Write something", selectionAction: "select", pasteAction: "paste", dropAction: "drop" },
              { type: "stack", direction: "row", children: [
                { type: "button", label: "Save", action: "save", primary: true },
                { type: "text", text: status, tone: status.startsWith("Not saved") ? "error" : "muted" },
              ] },
            ],
          }
        : { type: "text", text: "Pick a note, or make a new one.", tone: "muted" },
    );
  };

  const open = async (id, api) => {
    if (openId) await api.hooks.emit("close", null);
    openId = id;
    draft = find(id)?.text ?? "";
    selection = { from: 0, to: 0 };
    status = "";
    dirty = false;
    revision++;
    render(api);
    await remember(api);
    await api.hooks.emit("open", snapshot(false));
  };

  const save = async (api) => {
    if (!openId) return;
    // A note deleted elsewhere while the person kept editing it is made again with what they wrote.
    const id = openId;
    const saving = revision;
    const result = await api.call("data", "put", "notes", { id, title: titleOf(draft), text: draft });
    await list(api);
    // The person moved on (typed more, or opened another note) while the save was on its way: keep their edits as they are.
    if (openId !== id || revision !== saving) return render(api);
    status = result.ok ? "Saved" : `Not saved: ${result.error ?? (result.errors ?? []).join(", ")}`;
    if (result.ok) dirty = false;
    render(api);
    await remember(api);
    if (result.ok) await api.hooks.emit("save", snapshot(false));
  };

  ctx.ui.onEvent(async (action, value) => {
    // Pinned to this action's trace, so the write and the hooks after each await are traced with it.
    const here = ctx.traced();
    if (action === "new") {
      const result = await here.call("data", "put", "notes", { title: "Untitled" });
      await list(here);
      return open(result.id, here);
    }
    if (action.startsWith("open:")) return open(action.slice(5), here);
    if (action === "edit") {
      draft = String(value ?? "");
      status = "Unsaved changes";
      dirty = true;
      revision++;
      void remember(here);
      return here.hooks.emit("change", snapshot(true));
    }
    if (action === "save") return save(here);
    if (action === "select" && openId && value && typeof value === "object") {
      selection = { from: Number(value.from) || 0, to: Number(value.to) || 0 };
      return here.hooks.emit("selection", { ...selection, text: draft.slice(selection.from, selection.to) });
    }
    if ((action === "paste" || action === "drop") && openId && value && typeof value === "object") return put(action, value, here);
  });

  /**
   * A paste or drop: its listeners may change what goes in, then it replaces the range it was made on, like
   * typing. With no text of its own (files only), a dropped text file's text goes in.
   */
  const put = async (hook, value, api) => {
    const from = Math.max(0, Math.min(Number(value.from) || 0, draft.length));
    const to = Math.max(from, Math.min(Number(value.to) || 0, draft.length));
    const files = Array.isArray(value.files) ? value.files : [];
    const offered = { from, to, text: String(value.text ?? ""), html: String(value.html ?? ""), files, selected: draft.slice(from, to) };
    if (!offered.text) offered.text = files.map((f) => f.text ?? "").filter(Boolean).join("\n");
    const answer = await api.hooks.call(hook, offered);
    if (!answer || answer.block || typeof answer.text !== "string" || !answer.text) return render(api);
    draft = draft.slice(0, from) + answer.text + draft.slice(to);
    selection = { from: from + answer.text.length, to: from + answer.text.length };
    status = "Unsaved changes";
    dirty = true;
    revision++;
    render(api);
    void remember(api);
    return api.hooks.emit("change", snapshot(true));
  };

  // A note can also change from elsewhere: another plugin's reviewed write. Show it, unless the person has
  // unsaved edits of their own.
  ctx.on("data:changed:notes", async function (change) {
    const here = this ?? ctx;
    await list(here);
    // The open note was deleted elsewhere. With nothing unsaved it closes; unsaved edits stay, and Save makes it again.
    if (change.id === openId && !change.after) {
      if (dirty) status = "Deleted elsewhere: Save keeps your text as a new copy";
      else {
        openId = undefined;
        await remember(here);
        await here.hooks.emit("close", null);
      }
      return render(here);
    }
    const text = change.after?.text ?? "";
    if (change.id === openId && !dirty && draft !== text) {
      draft = text;
      revision++;
      await remember(here);
      status = "Changed by a plugin";
      render(here);
      // Tell note listeners (word count, the editor shim) what the note now says.
      return here.hooks.emit("save", snapshot(false));
    }
    render(here);
  });

  await list();
  if (!notes.length) {
    await ctx.call("data", "put", "notes", { id: "welcome", title: "Welcome", text: WELCOME });
    await list();
  }
  // Started again (its tab closed, or the kernel did): carry on with the note that was open, edits and all.
  const kept = await ctx.storage.get("open");
  if (kept && typeof kept === "object" && typeof kept.id === "string" && (find(kept.id) || kept.dirty)) {
    openId = kept.id;
    draft = String(kept.draft ?? "");
    dirty = !!kept.dirty;
    status = dirty ? "Unsaved changes" : "";
    render();
    await ctx.hooks.emit("open", snapshot(dirty));
  } else render();
}
