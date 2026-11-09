// Posts: the Markdown editor's document. It lists the Markdown files in the
// site folder (the `folder` service: a folder the person picks, or a private
// one until they do), opens one in a <ui-editor>, and saves it back.
//
// Everything else in the editor is another plugin, and hears what happens
// here through this plugin's hooks:
//
//   posts:open, posts:change, posts:save   the post, as a snapshot (below)
//   posts:close                            no post is open any more
//   posts:selection                        { from, to, text } when the selection settles
//   posts:paste, posts:drop                a waterfall: return { text } to put in something else
//   posts:before-save                      a waterfall: return { text } to save something else, or { block }
//
// and changes the open post through its `document` service, as the person
// would: edits go into the editor as edits they can undo, and are saved only
// when the post is saved. Underlines (annotate) and moving the selection
// (select) are the service's too, and so is how the editor works
// (setOption: the browser's spell check, and the words it accepts).
//
// A snapshot is { path, url, title, siteName, text, bodyStart, frontMatter,
// selection, unsaved }: offsets count characters in the whole file, front
// matter included, and the body starts at bodyStart. frontMatter has the
// top-level fields, keys in lowercase.

export const manifest = {
  id: "posts",
  name: "Posts",
  description: "The site's Markdown posts: open one, write, save. Other plugins hear what you do through its hooks, and change the post through its document service.",
  version: "1.0.0",
  permissions: ["ui", "folder:read", "folder:write", "folder:choose", "provide:document"],
  services: ["folder"],
  order: 10,
  hooks: {
    open: { mode: "emit", args: "{ path, url, title, siteName, text, bodyStart, frontMatter, selection, unsaved }", description: "A post was opened." },
    change: { mode: "emit", args: "{ path, url, title, siteName, text, bodyStart, frontMatter, selection, unsaved }", description: "The open post changed: the person typed (after a short pause), or a plugin edited it. unsaved is true." },
    save: { mode: "emit", args: "{ path, url, title, siteName, text, bodyStart, frontMatter, selection, unsaved }", description: "The open post was saved to the folder." },
    close: { mode: "emit", args: "null", description: "No post is open any more." },
    selection: { mode: "emit", args: "{ from, to, text }", description: "The selection in the open post settled: offsets into its text, and the text selected." },
    paste: {
      mode: "waterfall",
      timeoutMs: 2000,
      args: "{ from, to, text, html, files, selected }",
      description: "The person pasted into the post, over from..to (the text `selected`). Return { text } to put in something else, or { block } to paste nothing. files are { name, type, size, text?, dataUrl? }.",
    },
    drop: {
      mode: "waterfall",
      timeoutMs: 2000,
      args: "{ from, to, text, html, files, selected }",
      description: "The person dropped text or files on the post, at from..to. Return { text } to put in something else, or { block } to drop nothing. A dropped text file's text goes in if nothing else does.",
    },
    "before-save": {
      mode: "waterfall",
      timeoutMs: 3000,
      args: "{ path, url, title, siteName, text, bodyStart, frontMatter, selection, unsaved }",
      description: "Before the open post is saved. Return { text } to save different text (it goes into the editor too), or { block: reason } to stop the save.",
    },
  },
  provides: {
    document: {
      description: "The post open in the Markdown editor.",
      methods: {
        read: { args: "()", params: [], returns: "the post's snapshot, or null", needs: "document:read", description: "The open post as it is now, saved or not." },
        list: { args: "()", params: [], returns: "[{ path, url, title, section, date, draft, tags, categories }]", needs: "document:read", description: "Every post in the site (Markdown files under content/), from their front matter." },
        annotate: {
          args: "(set, [{ from, to, severity, message }])",
          params: [
            { name: "set", schema: { type: "string", description: "A name for this set of underlines; the next call with the same name replaces them" } },
            { name: "annotations", schema: { type: "array", items: { type: "object", properties: { from: { type: "integer", minimum: 0 }, to: { type: "integer", minimum: 0 }, severity: { type: "string", enum: ["info", "warning", "error"] }, message: { type: "string" } }, required: ["from", "to"] } } },
          ],
          returns: "true",
          needs: "document:read",
          description: "Underlines ranges of the open post, with a note on hover. Each plugin's `set` replaces its last one; an empty list clears it.",
        },
        select: {
          args: "(from, to?)",
          params: [
            { name: "from", schema: { type: "integer", minimum: 0, description: "Offset into the post's whole text" } },
            { name: "to", schema: { type: "integer", minimum: 0, description: "End of the range; leave out to put the caret at from" }, optional: true },
          ],
          returns: "true or false",
          needs: "document:read",
          description: "Selects a range of the open post and scrolls to it.",
        },
        applyEdits: {
          args: "([{ find, replace }])",
          params: [{ name: "edits", schema: { type: "array", items: { type: "object", properties: { find: { type: "string", description: "Text that occurs exactly once in the post" }, replace: { type: "string" } }, required: ["find", "replace"] } } }],
          returns: "{ applied, problems }",
          needs: "document:write",
          description: "Edits the open post: each find must occur exactly once. The person can undo them, and they are saved only when the post is.",
        },
        insert: { args: "(text)", params: [{ name: "text", schema: { type: "string" } }], returns: "true or false", needs: "document:write", description: "Puts text in at the selection, replacing what is selected." },
        setFrontMatter: {
          args: "(key, value)",
          params: [
            { name: "key", schema: { type: "string", description: "A top-level field, such as title or tags" } },
            { name: "value", schema: { description: "A string, number, boolean or list of strings; null removes the field" } },
          ],
          returns: "true or false",
          needs: "document:write",
          description: "Sets one top-level front matter field (null removes it): a string, number, boolean or list of strings.",
        },
        save: { args: "()", params: [], returns: "true or false", needs: "document:write", description: "Saves the open post, as the Save button does (before-save listeners run first)." },
        setOption: {
          args: "(name, value)",
          params: [
            { name: "name", schema: { type: "string", enum: ["spellcheck", "words"], description: "spellcheck: whether the browser checks the spelling; words: words it should accept" } },
            { name: "value", schema: { description: "true or false for spellcheck; a list of words for words" } },
          ],
          returns: "true or false",
          needs: "document:write",
          description: "Changes how the editor works, not the post: whether the browser checks the spelling as you type (spellcheck), and the words it should accept (words, such as the site's tags and product names).",
        },
      },
    },
  },
};

const SAMPLE = {
  "config.toml": 'title = "Sample site"\nbaseURL = "https://example.com/"\n',
  "content/posts/welcome.md": `---
title: "Welcome to the editor"
date: 2026-11-09
draft: false
tags: [writing, editor]
description: "A first post, to show what the editor's plugins do as you write."
---

## What this is

Every part of this editor is a plugin. The word count, the outline, the
readability grade and the underlines are each one file you can switch off.

## Try it

Write a very long sentence that goes on and on with clause after clause and never quite stops because there is always one more thing to say about it, and the readability plugin will underline it.

Link to [the second post](/posts/second-post/) or to a page that [isn't there](/nowhere/).
`,
  ".editor/style-guide.json": '{ "replace": { "utilise": "use", "e-mail": "email" }, "avoid": ["very", "basically"] }\n',
  "content/posts/second-post.md": `---
title: "A second post"
date: 2026-11-08
draft: true
tags: [notes]
---

A short one. In 2025, 42% of drafts were never finished.
`,
};

const DOCUMENT = /\.(md|markdown)$/i;

/** Where the front matter ends, and its fields: YAML (---), TOML (+++) or JSON ({…}). */
export function parseFrontMatter(text) {
  const fields = {};
  let bodyStart = 0;
  let kind = null;
  const fence = /^(---|\+\+\+)[ \t]*\r?\n/.exec(text);
  if (fence) {
    const close = new RegExp(`\\r?\\n${fence[1] === "---" ? "---" : "\\+\\+\\+"}[ \\t]*(\\r?\\n|$)`).exec(text.slice(fence[0].length - 1));
    if (close) {
      kind = fence[1] === "---" ? "yaml" : "toml";
      const head = text.slice(fence[0].length, fence[0].length - 1 + close.index);
      bodyStart = fence[0].length - 1 + close.index + close[0].length;
      const clean = (v) => v.trim().replace(/^["']|["']$/g, "");
      const list = (v) => v.replace(/^\[|\]$/g, "").split(",").map(clean).filter(Boolean);
      let key;
      // A YAML block scalar (`key: |` or `key: >`): its indented lines, joined once it ends.
      let block = null;
      const finish = () => {
        if (!block) return;
        const lines = [...block.lines];
        while (lines.length && !lines.at(-1).trim()) lines.pop();
        const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
        const body = lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
        fields[block.key] = block.fold ? body.join(" ").replace(/\s+/g, " ").trim() : body.join("\n");
        block = null;
      };
      for (const line of head.split(/\r?\n/)) {
        if (block) {
          if (!line.trim() || /^\s/.test(line)) {
            block.lines.push(line);
            continue;
          }
          finish();
        }
        // TOML: fields after the first [table] belong to that table, not the page.
        if (kind === "toml" && /^\s*\[/.test(line)) break;
        // A list item, indented under its key or (YAML allows it) not.
        const item = kind === "yaml" ? /^\s*-\s+(.*)$/.exec(line) : null;
        if (item && key) {
          fields[key] = [...(Array.isArray(fields[key]) ? fields[key] : []), clean(item[1])];
          continue;
        }
        // Only top-level keys: indented ones belong to a map under the key above.
        const m = /^([A-Za-z_][\w-]*)\s*[:=]\s*(.*)$/.exec(line);
        if (!m) continue;
        key = m[1].toLowerCase();
        const value = m[2].trim();
        if (kind === "yaml" && /^[|>][+-]?\d*$/.test(value)) {
          block = { key, fold: value.startsWith(">"), lines: [] };
          continue;
        }
        fields[key] = value.startsWith("[") ? list(value) : clean(value);
      }
      finish();
    }
  } else if (text.startsWith("{")) {
    // JSON front matter ends at the brace that closes the first (braces in strings don't count).
    let depth = 0;
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === "\\") i++;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          for (const [k, v] of Object.entries(JSON.parse(text.slice(0, i + 1)))) fields[k.toLowerCase()] = Array.isArray(v) ? v.map(String) : String(v);
          kind = "json";
          bodyStart = text[i + 1] === "\n" ? i + 2 : i + 1;
        } catch {
          // Not front matter after all.
        }
        break;
      }
    }
  }
  return { fields, bodyStart, kind };
}

/** The text with one top-level front matter field set (or removed, for null), in the front matter's own format. */
export function setField(text, key, value) {
  const { kind, bodyStart } = parseFrontMatter(text);
  const quote = (v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v)));
  const format = (v) => (Array.isArray(v) ? `[${v.map(quote).join(", ")}]` : quote(v));
  if (kind === "json") {
    const head = JSON.parse(text.slice(0, bodyStart).trim());
    if (value === null) delete head[key];
    else head[key] = value;
    return `${JSON.stringify(head, null, 2)}\n${text.slice(bodyStart)}`;
  }
  const sep = kind === "toml" ? " = " : ": ";
  if (!kind) return value === null ? text : `---\n${key}${sep}${format(value)}\n---\n\n${text}`;
  const lines = text.slice(0, bodyStart).split("\n");
  // lines[0] is the opening fence; `close` is the closing one. For TOML, the page's own fields end at the first [table].
  const close = lines.findLastIndex((line) => /^(---|\+\+\+)[ \t]*\r?$/.test(line));
  let end = close;
  if (kind === "toml") {
    const table = lines.findIndex((line, i) => i > 0 && i < close && /^\s*\[/.test(line));
    if (table > 0) end = table;
  }
  const at = lines.findIndex((line, i) => i > 0 && i < end && new RegExp(`^${key}\\s*[:=]`, "i").test(line));
  const line = `${key}${sep}${format(value)}`;
  if (at >= 0) {
    // The field's value may go on below it: indented lines (a list, a block scalar, a map, a TOML array),
    // YAML list items at the start of the line, and blank lines between them.
    const more = (l) => /^\s+\S/.test(l) || (kind === "yaml" && /^-(\s|$)/.test(l)) || (kind === "toml" && /^\s*\]/.test(l));
    let after = at + 1;
    while (after < end) {
      if (more(lines[after])) after++;
      else if (!lines[after].trim()) {
        let next = after;
        while (next < end && !lines[next].trim()) next++;
        if (next < end && more(lines[next])) after = next;
        else break;
      } else break;
    }
    lines.splice(at, after - at, ...(value === null ? [] : [line]));
  } else if (value !== null) {
    lines.splice(end > 0 ? end : 1, 0, line);
  }
  return lines.join("\n") + text.slice(bodyStart);
}

const slug = (title) =>
  title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "untitled";

const today = () => new Date().toISOString().slice(0, 10);

export default async function (ctx) {
  /** The site's posts, from their front matter: { path, url, title, section, date, draft, tags, categories }. */
  let posts = [];
  let folder = { name: "", picked: false, allowed: true };
  let open = null; // { path, saved } once a post is open
  let draft = "";
  let selection = { from: 0, to: 0 };
  /** The ui-editor's revision: changed when the text changes for any reason but the person typing. */
  let revision = 0;
  let selectAt = "";
  let selects = 0;
  /** Each plugin's underlines, by `<plugin> <set>`. */
  const notes = new Map();
  let status = "";
  let problem = "";
  let saving = false;
  /** How the editor works, which plugins change with document.setOption. */
  const options = { spellcheck: false, words: [] };

  const unsaved = () => !!open && draft !== open.saved;
  /**
   * The open post and its draft, kept in this plugin's storage: one worker serves every tab, and when the
   * tab that started it closes it starts again, so unsaved writing must outlive it.
   */
  const remember = (api) => api.storage.set("open", open ? { path: open.path, saved: open.saved, draft } : null);
  const siteName = () => folder.name || "Site";
  /** The URL Hugo gives a post: /<section>/<slug>/, or the bundle's folder for index.md. */
  const urlOf = (path, fields = {}) => {
    const rest = path.replace(/^content\//, "").replace(DOCUMENT, "");
    const parts = rest.split("/");
    if (/^_?index$/.test(parts.at(-1))) parts.pop();
    else if (fields.slug) parts[parts.length - 1] = fields.slug;
    return `/${parts.join("/")}${parts.length ? "/" : ""}`;
  };
  const snapshot = () => {
    if (!open) return null;
    const { fields, bodyStart } = parseFrontMatter(draft);
    return { path: open.path, url: urlOf(open.path, fields), title: fields.title || open.path.split("/").pop(), siteName: siteName(), text: draft, bodyStart, frontMatter: fields, selection, unsaved: unsaved() };
  };

  const draw = (api = ctx) => {
    const groups = new Map();
    for (const post of posts) groups.set(post.section, [...(groups.get(post.section) ?? []), { ...post, open: post.path === open?.path }]);
    api.ui.views("posts.html").render("files", "files", {
      folder: { ...folder, needsAllow: folder.picked && !folder.allowed },
      sections: [...groups].map(([name, list]) => ({ name, posts: list })),
      empty: !posts.length,
      problem,
    });
    const shown = snapshot();
    api.ui.views("posts.html").render("main", "editor", {
      open: !!open,
      title: shown?.title ?? "",
      path: open?.path ?? "",
      unsaved: unsaved(),
      status,
      text: draft,
      revision: `${open?.path ?? ""}#${revision}`,
      select: selectAt,
      annotations: JSON.stringify([...notes.values()].flat().slice(0, 2000)),
      spellcheck: options.spellcheck ? "true" : "false",
      words: JSON.stringify(options.words),
    });
  };

  /** Reads every post's front matter, for the list and for document.list(). */
  const scan = async (api = ctx) => {
    folder = await api.call("folder", "about");
    if (folder.picked && !folder.allowed) {
      posts = [];
      return;
    }
    let paths = await api.call("folder", "list", "content");
    if (!paths.length && !folder.picked) {
      // A new private folder: a small site to start with.
      for (const [path, text] of Object.entries(SAMPLE)) await api.call("folder", "write", path, text);
      paths = await api.call("folder", "list", "content");
    }
    const found = [];
    for (const path of paths.filter((p) => DOCUMENT.test(p)).slice(0, 2000)) {
      const text = (await api.call("folder", "read", path)) ?? "";
      const { fields } = parseFrontMatter(text);
      const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
      found.push({
        path,
        url: urlOf(path, fields),
        title: fields.title || path.split("/").pop().replace(DOCUMENT, ""),
        section: path.split("/")[1] && path.split("/").length > 2 ? path.split("/")[1] : "pages",
        date: fields.date || undefined,
        draft: fields.draft === "true",
        tags: list(fields.tags),
        categories: list(fields.categories),
      });
    }
    posts = found.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")) || a.title.localeCompare(b.title));
  };

  const close = async (api) => {
    if (!open) return;
    open = null;
    draft = "";
    notes.clear();
    await remember(api);
    await api.hooks.emit("close", null);
  };

  /** Opens a post from the folder; `kept` is its unsaved draft from before this worker started again. */
  const openPost = async (path, api, kept) => {
    const text = await api.call("folder", "read", path);
    if (text === null) {
      problem = `${path} isn't in the folder any more.`;
      return draw(api);
    }
    await close(api);
    open = { path, saved: text };
    draft = text;
    status = "";
    if (kept && typeof kept.draft === "string" && kept.draft !== text) {
      draft = kept.draft;
      if (kept.saved !== text) status = "Unsaved changes kept, but the file changed on disk since: saving replaces it.";
    }
    selection = { from: 0, to: 0 };
    revision++;
    problem = "";
    await remember(api);
    draw(api);
    await api.hooks.emit("open", snapshot());
  };

  /** The text changed for a reason other than typing (a plugin's edit, a paste): into the editor, and told. */
  const changed = async (text, api) => {
    draft = text;
    revision++;
    status = "";
    draw(api);
    await remember(api);
    await api.hooks.emit("change", snapshot());
  };

  const save = async (api) => {
    if (!open || saving) return false;
    saving = true;
    try {
      const path = open.path;
      // What the listeners check is what is saved: typing that goes on meanwhile stays unsaved.
      const checked = draft;
      const verdict = await api.hooks.call("before-save", snapshot());
      if (open?.path !== path) return false;
      if (verdict?.block) {
        status = `Not saved: ${verdict.block}`;
        draw(api);
        return false;
      }
      let text = checked;
      if (typeof verdict?.text === "string" && verdict.text !== checked) {
        if (draft !== checked) {
          status = "Not saved: the post changed while it was being checked. Save again.";
          draw(api);
          return false;
        }
        text = draft = verdict.text;
        revision++;
      }
      await api.call("folder", "write", path, text);
      if (open?.path !== path) return true;
      open.saved = text;
      await remember(api);
      status = "Saved";
      await scan(api);
      draw(api);
      await api.hooks.emit("save", snapshot());
      return true;
    } catch (error) {
      status = `Not saved: ${error instanceof Error ? error.message : error}`;
      draw(api);
      return false;
    } finally {
      saving = false;
    }
  };

  /** A paste or drop: its listeners may change what goes in, then it replaces the range it was made on. */
  const put = async (hook, value, api) => {
    const from = Math.max(0, Math.min(Number(value.from) || 0, draft.length));
    const to = Math.max(from, Math.min(Number(value.to) || 0, draft.length));
    const files = Array.isArray(value.files) ? value.files : [];
    const offered = { from, to, text: String(value.text ?? ""), html: String(value.html ?? ""), files, selected: draft.slice(from, to) };
    if (!offered.text) offered.text = files.map((f) => f.text ?? "").filter(Boolean).join("\n");
    const path = open.path;
    const before = draft;
    const answer = await api.hooks.call(hook, offered);
    // Another post opened, or the text changed, while the listeners ran: the offsets no longer fit.
    if (open?.path !== path || draft !== before) return draw(api);
    if (!answer || answer.block || typeof answer.text !== "string" || !answer.text) return draw(api);
    selection = { from: from + answer.text.length, to: from + answer.text.length };
    await changed(draft.slice(0, from) + answer.text + draft.slice(to), api);
  };

  const newPost = async (title, api) => {
    const name = String(title ?? "").trim();
    if (!name) return;
    let path = `content/posts/${slug(name)}.md`;
    for (let n = 2; posts.some((p) => p.path === path); n++) path = `content/posts/${slug(name)}-${n}.md`;
    await api.call("folder", "write", path, `---\ntitle: ${JSON.stringify(name)}\ndate: ${today()}\ndraft: true\ntags: []\n---\n\n`);
    await scan(api);
    await openPost(path, api);
  };

  /** Picks a site folder (or lets the picked one be used again): the old folder's post closes first. */
  const chooseFolder = async (how, api) => {
    try {
      if (how === "choose" && !(await api.call("folder", "choose"))) return;
      if (how === "allow") await api.call("folder", "allow");
      problem = "";
      await close(api);
      await scan(api);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    draw(api);
  };

  ctx.ui.onEvent(async (action, value) => {
    // Pinned to this action's trace, so its writes and hooks are traced with it.
    const here = ctx.traced();
    if (action === "edit" && open) {
      draft = String(value ?? "");
      status = "";
      draw(here);
      await remember(here);
      return here.hooks.emit("change", snapshot());
    }
    if (action === "select" && open && value && typeof value === "object") {
      selection = { from: Number(value.from) || 0, to: Number(value.to) || 0 };
      return here.hooks.emit("selection", { ...selection, text: draft.slice(selection.from, selection.to) });
    }
    if ((action === "paste" || action === "drop") && open && value && typeof value === "object") return put(action, value, here);
    if (action === "save") return save(here);
    if (action.startsWith("open:")) return openPost(action.slice(5), here);
    if (action === "new") return newPost(value?.title, here);
    if (action === "close") {
      await close(here);
      return draw(here);
    }
    if (action === "choose" || action === "allow") return chooseFolder(action, here);
    if (action === "rescan") {
      await scan(here);
      return draw(here);
    }
  });

  ctx.commands.add({ id: "save", title: "Save the post", keys: ["Mod+S"] }, () => save(ctx.traced()));
  ctx.commands.add({ id: "open-folder", title: "Open a site folder…" }, () => chooseFolder("choose", ctx.traced()));

  ctx.provide("document", {
    read: () => snapshot(),
    list: () => posts,
    // The runtime adds { caller } after the arguments given, so a method with optional arguments takes it off the end.
    annotate(...args) {
      const { caller } = args.pop();
      const [set, list] = args;
      const key = `${caller} ${String(set)}`;
      const kept = (Array.isArray(list) ? list : [])
        .filter((a) => a && Number.isFinite(a.from) && Number.isFinite(a.to) && a.from < a.to)
        .slice(0, 500)
        .map((a) => ({ from: a.from, to: a.to, severity: ["info", "warning", "error"].includes(a.severity) ? a.severity : "info", message: String(a.message ?? "").slice(0, 300) }));
      if (kept.length) notes.set(key, kept);
      else if (!notes.delete(key)) return true;
      draw();
      return true;
    },
    select(...args) {
      args.pop();
      const [from, to = from] = args;
      if (!open) return false;
      selection = { from: Number(from) || 0, to: Number(to) || 0 };
      selectAt = `${selection.from},${selection.to},${++selects}`;
      draw();
      return true;
    },
    async applyEdits(edits) {
      if (!open) return { applied: 0, problems: ["No post is open."] };
      let text = draft;
      let applied = 0;
      const problems = [];
      for (const [i, edit] of (Array.isArray(edits) ? edits : []).entries()) {
        const find = String(edit?.find ?? "");
        const first = find ? text.indexOf(find) : -1;
        if (!find) problems.push(`Edit ${i + 1}: empty find.`);
        else if (first === -1) problems.push(`Edit ${i + 1}: text not found: ${JSON.stringify(find.slice(0, 80))}`);
        else if (text.indexOf(find, first + 1) !== -1) problems.push(`Edit ${i + 1}: text occurs more than once; include more around it: ${JSON.stringify(find.slice(0, 80))}`);
        else {
          text = text.slice(0, first) + String(edit.replace ?? "") + text.slice(first + find.length);
          applied++;
        }
      }
      if (applied) await changed(text, ctx);
      return { applied, problems };
    },
    async insert(text) {
      if (!open) return false;
      const { from, to } = selection;
      const put = String(text);
      selection = { from: from + put.length, to: from + put.length };
      selectAt = `${selection.from},${selection.to},${++selects}`;
      await changed(draft.slice(0, from) + put + draft.slice(to), ctx);
      return true;
    },
    async setFrontMatter(key, value) {
      if (!open || typeof key !== "string" || !/^[A-Za-z_][\w-]*$/.test(key)) return false;
      await changed(setField(draft, key, value), ctx);
      return true;
    },
    save: () => save(ctx),
    setOption(name, value) {
      if (name === "spellcheck") options.spellcheck = value === true;
      else if (name === "words" && Array.isArray(value)) options.words = [...new Set(value.filter((w) => typeof w === "string" && w && w.length <= 64 && !/\s/.test(w)))].slice(0, 5000);
      else return false;
      draw();
      return true;
    },
  });

  try {
    await scan();
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  // Opens the post that was open last time, or the newest.
  const last = await ctx.storage.get("open");
  const kept = last && typeof last === "object" ? last : null;
  const lastPath = kept ? kept.path : last;
  const first = posts.find((p) => p.path === lastPath) ?? posts[0];
  if (first) await openPost(first.path, ctx, first.path === kept?.path ? kept : undefined);
  else draw();
}
