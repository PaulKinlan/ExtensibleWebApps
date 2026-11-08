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
// It asks through the `llm` service, so it needs the `llm` permission and
// never sees a key: the provider plugin asks the person for one the first
// time, and the kernel keeps it. It reads the plugins with `plugins:read`,
// and their permissions and hooks from the kernel's reference. What it sends
// the model is shown under each answer, so nothing is hidden.

export const manifest = {
  id: "ask-the-page",
  name: "Ask the page",
  description: "Answers questions about this page with a language model, from the plugins it is made of.",
  version: "1.0.0",
  permissions: ["ui", "llm", "plugins:read"],
  services: ["llm"],
  // Its tab says which app it is about.
  scope: "tab",
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
Answer from the plugins described below, in plain words for someone who may not code. Name plugins by their names. Keep it short: a few sentences or a short list. If the page doesn't say, say so.`;

export default function (ctx) {
  const views = ctx.ui.views("ask-the-page.html");
  /** The provider the person picked; empty for the first that has its key. */
  let provider = "";
  let question = "";
  let answer = null;
  let error = "";
  let asking = false;

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
    const list = await ctx.call("llm", "providers").catch(() => []);
    // A model switched off or removed can't answer: go back to the first with a key.
    if (provider && !list.some((p) => p.id === provider)) provider = "";
    const providers = list.map((p) => ({ ...p, picked: p.id === provider, label: `${p.name}${p.ready ? "" : " (asks for a key)"}` }));
    views.render("ask", "ask", { providers, none: !providers.length, question, answer, error, asking, suggested: SUGGESTED.map((text, n) => ({ n, text })) }, { order: 10 });
    return providers.length;
  };

  const ask = async (text) => {
    question = String(text ?? "").trim().slice(0, 2000);
    if (!question) return;
    asking = true;
    error = "";
    answer = null;
    await draw();
    try {
      const { context, named } = await describe(question);
      const reply = await ctx.call("llm", "complete", {
        system: `${SYSTEM}\n\n${context}`,
        messages: [{ role: "user", content: question }],
        maxTokens: 1024,
        ...(provider ? { provider } : {}),
      });
      answer = {
        text: reply.text || "(The model gave no answer.)",
        by: `${(await ctx.call("llm", "providers")).find((p) => p.id === reply.provider)?.name ?? reply.provider}${reply.model ? `, ${reply.model}` : ""}`,
        tokens: `${reply.usage.input} in, ${reply.usage.output} out`,
        sent: `System:\n${SYSTEM}\n\n${context}\n\nYou:\n${question}`,
        named: named.length ? `It also sent the code of ${named.join(", ")}.` : "",
      };
    } catch (e) {
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
    if (action.startsWith("suggest:")) await ask(SUGGESTED[Number(action.slice(8))]);
  });
}
