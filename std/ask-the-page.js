// Ask the page: a question box that a language model answers from what the
// page is made of. It tells the model about every plugin the app links (its
// name, what it says it does, its permissions and the hooks it listens to)
// and, for the plugins a question names, their code.
//
// Add it to any app with two lines in its app.html, beside at least one
// language model (std/llm/):
//
//   <link rel="plugin" href="/std/ask-the-page.js">
//   <slot name="ask"></slot>
//
// or, as a person, from Customize's Add a plugin. On a page with no language
// model, it offers the ones this site has (llm.choices); the one the person
// picks becomes their own plugin for the app, once they allow it on a review card
// (llm.add), and asks for their API key the first time it is asked.
//
// It asks through `llm.stream` and listens to `llm:chunk` so words appear live
// as the model writes them, while never seeing a key: the provider plugin asks
// the person for one the first time, and the kernel keeps it. It reads the
// plugins with `plugins:read`, and their permissions and hooks from the
// kernel's reference. What it sends the model is shown under each answer, so
// nothing is hidden.

export const manifest = {
  id: "ask-the-page",
  name: "Ask the page",
  description: "Answers questions about this page with a language model, from the plugins it is made of.",
  version: "1.1.0",
  permissions: ["ui", "llm", "plugins:read"],
  services: ["llm"],
  // Its tab says which app it is about.
  scope: "tab",
  // Where it draws on a page with no <slot name="ask">, such as a person adding it to any app from the
  // registry (packages/std.json); a page with the slot keeps it there.
  places: { "ask": { at: "main", put: "append" } },
  // Copied with it when a person adds it to an app.
  files: ["ask-the-page.html"],
};

/** Questions to start from. */
const SUGGESTED = [
  "What does each plugin on this page do?",
  "Which plugins can stop a note being saved, and how?",
  "How does Note stats know when a note is added?",
];

/** The most code it sends for the plugins a question names. */
const CODE = 40_000;

const SYSTEM = `You answer questions about a web page built on Extensible Web Apps: a small kernel, and plugins that each run in their own Web Worker and can do only what their manifest's permissions allow. Hooks are named events: an emit hook tells listeners, a serial hook asks each listener in turn and any one can stop the action.
Answer from the plugins described below, in plain words for someone who may not code. Name plugins by their names. Keep it short: a few sentences or a short list. Your answer is shown as plain text, so don't use Markdown: no **bold**, no backticks, no # headings. If the page doesn't say, say so.`;

export default function (ctx) {
  const views = ctx.ui.views("ask-the-page.html");
  /** The provider the person picked; empty for the first that has its key. */
  let provider = "";
  let cachedProviders = [];
  let question = "";
  let answer = null;
  let error = "";
  let asking = false;
  /** The site's language models to offer when the page has none; filled in only then. */
  let choices = [];
  /** The model being added, and why the last add didn't happen. */
  let adding = "";
  let addError = "";
  let streamSeq = 0;
  let activeStream = null;
  let streamTimer;

  /** Renders from the current state without awaiting a fresh provider query (used for live streaming chunks). */
  const paint = () => {
    const providers = cachedProviders.map((p) => ({ ...p, picked: p.id === provider, label: `${p.name}${p.ready ? "" : " (asks for a key)"}` }));
    const none = !providers.length;
    views.render("ask", "ask", { providers, none, choices, offered: choices.length > 0, adding, addError, question, answer, error, asking, suggested: SUGGESTED.map((text, n) => ({ n, text })) }, { order: 10 });
  };

  /** Every plugin the app links, described for the model, and whether the question names it. */
  const describe = async (text) => {
    const plugins = await ctx.call("plugins", "app");
    const reference = await ctx.call("kernel", "reference");
    const known = new Map(reference.plugins.map((p) => [p.id, p]));
    const lower = text.toLowerCase();
    const named = plugins.filter((p) => lower.includes(p.name.toLowerCase()) || lower.includes(p.id));
    const lines = plugins.map((p) => {
      const r = known.get(p.id);
      return `- ${p.name} (${p.id}), ${p.enabled ? "on" : "off"}: ${p.description || "no description"}. Permissions: ${r?.permissions.join(", ") || "none"}. Listens to: ${r?.hooks.join(", ") || "nothing"}.`;
    });
    let code = "";
    /** The plugins whose code was sent: one too large, or unreadable, is left out. */
    const sent = [];
    for (const p of named) {
      const source = await ctx.call("authoring", "source", p.id).catch(() => null);
      if (!source || code.length + source.code.length > CODE) continue;
      code += `\n\n${p.name} (${p.id}):\n\`\`\`js\n${source.code}\n\`\`\``;
      sent.push(p.name);
    }
    return { context: `The plugins on this page, in order:\n${lines.join("\n")}${code ? `\n\nThe code of the plugins the question names:${code}` : ""}`, named: sent };
  };

  /** Draws, and says how many language models it found. */
  const draw = async () => {
    cachedProviders = await ctx.call("llm", "providers").catch(() => []);
    // A model switched off or removed can't answer: go back to the first with a key.
    if (provider && !cachedProviders.some((p) => p.id === provider)) provider = "";
    if (!cachedProviders.length) choices = (await ctx.call("llm", "choices").catch(() => [])).map((c) => ({ ...c, busy: !!adding }));
    paint();
    return cachedProviders.length;
  };

  ctx.on("llm:chunk", (chunk) => {
    if (!activeStream || chunk?.streamId !== activeStream.id || chunk.done || !chunk.delta) return;
    activeStream.text += chunk.delta;
    answer = {
      text: activeStream.text,
      by: activeStream.by,
      tokens: "streaming…",
      sent: activeStream.sent,
      named: activeStream.named,
    };
    if (!activeStream.painted) {
      activeStream.painted = true;
      paint();
    } else if (!streamTimer) {
      streamTimer = setTimeout(() => {
        streamTimer = undefined;
        if (activeStream) paint();
      }, 30);
    }
  });

  const ask = async (text) => {
    question = String(text ?? "").trim().slice(0, 2000);
    if (!question) return;
    asking = true;
    error = "";
    answer = null;
    await draw();
    const streamId = `ask-${++streamSeq}`;
    try {
      const { context, named } = await describe(question);
      const sent = `System:\n${SYSTEM}\n\n${context}\n\nYou:\n${question}`;
      const namedNote = named.length ? `It also sent the code of ${named.join(", ")}.` : "";
      const chosenName = (provider ? cachedProviders.find((p) => p.id === provider) : (cachedProviders.find((p) => p.preferred) ?? cachedProviders.find((p) => p.ready) ?? cachedProviders[0]))?.name ?? "the model";
      activeStream = { id: streamId, text: "", by: chosenName, sent, named: namedNote, painted: false };
      const STREAM = "stream";
      const reply = await ctx.call("llm", STREAM, {
        streamId,
        system: `${SYSTEM}\n\n${context}`,
        messages: [{ role: "user", content: question }],
        maxTokens: 1024,
        ...(provider ? { provider } : {}),
      });
      clearTimeout(streamTimer);
      streamTimer = undefined;
      activeStream = null;
      answer = {
        text: reply.text || "(The model gave no answer.)",
        by: `${(await ctx.call("llm", "providers")).find((p) => p.id === reply.provider)?.name ?? reply.provider}${reply.model ? `, ${reply.model}` : ""}`,
        tokens: `${reply.usage.input} in, ${reply.usage.output} out`,
        sent,
        named: namedNote,
      };
    } catch (e) {
      clearTimeout(streamTimer);
      streamTimer = undefined;
      activeStream = null;
      answer = null;
      error = e instanceof Error ? e.message : String(e);
    }
    asking = false;
    await draw();
  };

  /**
   * A model plugin that has just started, or been switched on, may not be listening yet when this
   * asks which models there are: draw now, and look again a little later. Several start at once,
   * so it stops only once it has found some and no more came since it last looked.
   */
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
    if (asking) return;
    if (action === "provider") {
      provider = typeof value === "string" ? value : "";
      await draw();
    }
    if (action === "ask") await ask(value?.question);
    // Adds one of the site's language models as the person's own plugin, after they allow it on a review card.
    if (action.startsWith("model:") && !adding) {
      adding = action.slice(6);
      addError = "";
      await draw();
      const result = await ctx.call("llm", "add", adding).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      if (!result?.ok) addError = result?.error ?? "It wasn't added";
      adding = "";
      await refresh([0, 500, 1000, 2000]);
    }
    if (action.startsWith("suggest:")) await ask(SUGGESTED[Number(action.slice(8))]);
  });
}
