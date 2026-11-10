// Plugin maker: an agent in the page that writes plugins for the person.
// They say what they want ("show how many books I finished this month"), a
// language model reads the page's plugins, writes one, checks it, and saves
// it as the person's own plugin for this app. Nothing runs until they accept
// the review card that shows its code and what it may do, as with any plugin
// they add. They can then ask for changes, and it saves the plugin again.
//
// A person adds it to any app from Customize's Add a plugin, or with "Write
// it for me" in Customize's Make tab, where it then draws too (the tab's
// `customize.make` slot); an app can link it too:
//
//   <link rel="plugin" href="/std/plugin-maker.js">
//   <slot name="plugin-maker"></slot>
//
// It asks through the `llm` service, so it never sees a key. On a page with
// no language model, it offers the ones this site has (llm.choices), and the
// one the person picks becomes their own plugin too (llm.add), which asks for
// their API key the first time it is asked.
//
// Its tools are the authoring service's, the same the plugin editor and the
// builder agent (std/agents/builder.agent.md) use: it can read the page's
// plugins and save the person's own, and nothing else.

export const manifest = {
  id: "plugin-maker",
  name: "Plugin maker",
  description: "Describe a plugin you want for this page: a language model writes it, and you accept its code before it runs.",
  version: "1.0.0",
  permissions: ["ui", "llm", "plugins:author"],
  services: ["llm"],
  // Its tab says which app it makes plugins for.
  scope: "tab",
  // On a page with no slot for it (a person adding it from the registry), it draws at the end of the page's main part.
  places: { "plugin-maker": { at: "main", put: "append" } },
  files: ["plugin-maker.html"],
};

/** Things to ask for, to start from. */
const SUGGESTED = ["Show a count of what's on this page, at the top", "Add a box for my own notes that remembers what I write", "Show today's date and time in the header"];

/** The most steps (model answers) one request takes, and the lines of the conversation it keeps. */
const STEPS = 12;
const KEEP = 40;

const SYSTEM = `You write plugins for a web app built on Extensible Web Apps, for the person using it, from what they describe. The app is the page they have open.

A plugin is one JavaScript module: a literal \`manifest\`, then a default function that gets \`ctx\`. It runs in its own Web Worker and can do only what its manifest's permissions allow.

\`\`\`js
export const manifest = {
  id: "reading-streak",            // lowercase letters, digits and dashes; new for a new plugin
  name: "Reading streak",
  description: "Shows how many books you finished this month.",
  version: "1.0.0",
  permissions: ["ui", "data:read:library"],
  // Where it draws, on a page with no <slot> for it: a CSS selector in the app's page, and how.
  places: { streak: { at: "main", put: "prepend" } },
};

export default function (ctx) {
  const draw = async () => {
    const books = await ctx.call("data", "list", "library");
    const done = books.filter((b) => b.shelf === "done").length;
    ctx.ui.render("streak", "streak", ctx.ui.html\`<ui-card><p>\${done} books finished</p></ui-card>\`);
  };
  ctx.on("data:changed:library", draw);
  void draw();
}
\`\`\`

What a plugin may use:
- ctx.ui.render(placeOrSlot, key, ctx.ui.html\`…\`) draws (needs "ui"). Render to the name of one of its own places. A place is { at: "<CSS selector>", put: "before" | "after" | "prepend" | "append" | "replace" | "hide" }. Prefer landmarks and ids: "main", "header", "aside", "footer", "#id", "[data-part=x]". put "prepend" in "main" puts it at the top; "append" at the end.
- The platform's elements: ui-card (tone="accent"), ui-toolbar, ui-badge, ui-stat, ui-table, ui-empty, ui-stack, ui-grid; ordinary buttons with data-action="name". Handle them with ctx.ui.onEvent((action, value) => …); a <form data-action="x"> sends its fields as value.
- ctx.call("data", "list" | "get" | "put" | "delete", collection, …) reads and writes the app's collections (needs "data:read:<name>" or "data:write:<name>"; writing another plugin's collection shows the person each write first, with the reason passed as the last argument). ctx.on("data:changed:<name>", fn) hears a change.
- A plugin can keep its own records by declaring collections in its manifest: collections: { notes: { title: "Notes", schema: { type: "object", required: ["text"], properties: { text: { type: "string", title: "Text" } } } } }. The kernel adds id and the times; don't declare them.
- ctx.commands.add({ id, title, keys? }, handler) adds a command to the palette. ctx.storage keeps small settings. ctx.log(...) writes to the trace.

Work like this:
1. Look first. page_plugins lists the plugins on the page, with the collections and hooks they use; plugin_source shows one's code, which tells you its collections, their fields and the slots its views have. Read the ones the request is about before you write.
2. Ask for as few permissions as the plugin needs.
3. Check your draft with check_plugin, and fix what it reports.
4. Save it with save_plugin. The person sees the code on a card and accepts or declines; the call waits for them. If they decline, ask them what to change.
5. To change a plugin you made, save it again with the same id. my_plugins lists the person's own plugins here.

If what they want can't be done by a plugin, or needs a permission no plugin should have, say so instead of writing one. When you finish, say in a sentence or two what you saved and what it does now. Write for someone who may not code. Your answer is shown as plain text, so don't use Markdown in it: no **bold**, no backticks, no # headings.`;

const TOOLS = [
  { name: "page_plugins", description: "The plugins on this page: id, name, description, whether each is on, its permissions and the hooks it listens to.", parameters: { type: "object", properties: {} } },
  { name: "plugin_source", description: "The code of one plugin on this page, by id.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "my_plugins", description: "The person's own plugins for this app, and whether each is on.", parameters: { type: "object", properties: {} } },
  { name: "check_plugin", description: "Reads a draft's manifest as the kernel will, and says what each permission lets it do, or what is wrong.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
  { name: "save_plugin", description: "Saves the plugin as the person's own for this app and turns it on, once they accept a review of its code. Waits for them.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
];

export default function (ctx) {
  const views = ctx.ui.views("plugin-maker.html");
  /** The model the person picked; empty for the first that has its key. */
  let provider = "";
  let providers = [];
  /** The site's language models to offer when the page has none, the one being added, and why the last add didn't happen. */
  let choices = [];
  let adding = "";
  let addError = "";
  /** What the person sees: { n, who, text, tone }. */
  const lines = [];
  let next = 0;
  /** The conversation the model sees, so "make it blue" means the plugin it just made. */
  let messages = [];
  /** The model the conversation is with: its turns carry that vendor's own state. */
  let used = "";
  let working = "";
  /** What's left in the box: emptied once a request is sent. */
  let draft = "";

  const say = (who, text, tone = "") => {
    lines.push({ n: ++next, who, text, tone });
    lines.splice(0, Math.max(0, lines.length - KEEP));
  };

  const draw = async () => {
    const list = await ctx.call("llm", "providers").catch(() => []);
    if (provider && !list.some((p) => p.id === provider)) provider = "";
    providers = list.map((p) => ({ ...p, picked: p.id === provider, label: `${p.name}${p.ready ? "" : " (asks for a key)"}` }));
    const none = !providers.length;
    if (none) choices = (await ctx.call("llm", "choices").catch(() => [])).map((c) => ({ ...c, busy: !!adding }));
    const view = {
      providers,
      none,
      choices,
      offered: choices.length > 0,
      adding,
      addError,
      lines,
      started: lines.length > 0,
      working,
      busy: !!working,
      suggested: SUGGESTED.map((text, n) => ({ n, text })),
      draft,
    };
    views.render("plugin-maker", "maker", view);
    // And in Customize's Make tab, which leaves a slot for it ("Or have it written for you").
    views.render("customize.make", "maker", view);
    return providers.length;
  };

  /** Runs one of the model's tool calls, and returns what to tell it. */
  const run = async (name, args) => {
    if (name === "page_plugins") {
      const [plugins, reference] = await Promise.all([ctx.call("plugins", "app"), ctx.call("kernel", "reference")]);
      const known = new Map(reference.plugins.map((p) => [p.id, p]));
      return plugins.filter((p) => p.id !== manifest.id).map((p) => ({ id: p.id, name: p.name, description: p.description, on: p.enabled, permissions: known.get(p.id)?.permissions ?? [], listens: known.get(p.id)?.hooks ?? [] }));
    }
    if (name === "plugin_source") return ctx.call("authoring", "source", String(args.id ?? ""));
    if (name === "my_plugins") return (await ctx.call("authoring", "mine")).map(({ id, name, description, on, error }) => ({ id, name, description, on, ...(error ? { error } : {}) }));
    if (name === "check_plugin") return ctx.call("authoring", "check", String(args.code ?? ""));
    if (name === "save_plugin") {
      working = "Showing you its code. Accept the review card to turn it on.";
      await draw();
      const result = await ctx.call("authoring", "save", String(args.code ?? ""));
      say("Plugin maker", result?.ok ? `Saved ${result.id}. It's on now: Customize lists it under your plugins.` : `Not saved: ${result?.error ?? "unknown"}`, result?.ok ? "success" : "warning");
      working = "Writing…";
      await draw();
      return result;
    }
    throw new Error(`No tool ${name}`);
  };

  const make = async (text) => {
    const request = String(text ?? "").trim().slice(0, 4000);
    if (!request || working) return;
    say("You", request);
    messages.push({ role: "user", content: request });
    // Declared as what was sent, then as empty once done, so the box empties (a view keeps typed text until its HTML changes).
    draft = request;
    working = "Writing…";
    await draw();
    try {
      for (let step = 0; step < STEPS; step++) {
        // Once a model has answered, the conversation stays with it, even on "the first with a key".
        const by = provider || used;
        const answer = await ctx.call("llm", "complete", { system: SYSTEM, messages, tools: TOOLS, maxTokens: 16000, ...(by ? { provider: by } : {}) });
        used = answer.provider;
        messages.push(answer.message);
        if (answer.stop !== "tool") {
          say("Plugin maker", answer.text || (answer.stop === "length" ? "The answer was cut off." : "(No answer.)"), answer.stop === "end" ? "" : "warning");
          return;
        }
        for (const call of answer.toolCalls) {
          let content;
          try {
            content = JSON.stringify((await run(call.name, call.args ?? {})) ?? null);
          } catch (e) {
            content = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
          }
          messages.push({ role: "tool", id: call.id, name: call.name, content: content.slice(0, 60_000) });
        }
      }
      say("Plugin maker", "That took more steps than I allow for one request. Tell me what to do next.", "warning");
    } catch (e) {
      say("Plugin maker", e instanceof Error ? e.message : String(e), "danger");
      // A conversation that ends on the person's turn or a tool's answer can't go on: start afresh.
      messages = [];
      used = "";
    } finally {
      // Keep the last turns only, starting from one of the person's, so a long conversation stays small.
      if (messages.length > 60) {
        const from = messages.findIndex((m, i) => i >= messages.length - 60 && m.role === "user" && typeof m.content === "string");
        messages = from > 0 ? messages.slice(from) : [];
        if (!messages.length) used = "";
      }
      working = "";
      draft = "";
      await draw();
    }
  };

  /** A model that has just been added or switched on may not be listening yet: look again a little later. */
  const refresh = async (waits) => {
    let last = -1;
    for (const wait of waits) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      const found = await draw();
      if (found && found === last) return;
      last = found;
    }
  };
  refresh([0, 500, 1000, 2000, 4000]);
  ctx.on("plugins:changed", () => refresh([0, 500, 1500]));

  ctx.ui.onEvent(async (action, value) => {
    if (action === "provider") {
      const picked = typeof value === "string" ? value : "";
      // Each vendor keeps its own record of a turn (state), which another can't read: a new model starts afresh.
      if (picked !== provider && messages.length && !working) {
        messages = [];
        used = "";
        say("Plugin maker", "New model: starting a new conversation. Your plugins stay as they are.");
      }
      provider = picked;
      return draw();
    }
    if (action === "make") return make(value?.text);
    if (action.startsWith("suggest:")) return make(SUGGESTED[Number(action.slice(8))]);
    if (action === "clear" && !working) {
      lines.length = 0;
      messages = [];
      used = "";
      return draw();
    }
    if (action.startsWith("model:") && !adding) {
      adding = action.slice(6);
      addError = "";
      await draw();
      const result = await ctx.call("llm", "add", adding).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      if (!result?.ok) addError = result?.error ?? "It wasn't added";
      adding = "";
      await refresh([0, 500, 1000, 2000]);
    }
  });
}
