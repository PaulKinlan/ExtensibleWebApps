// Chat: a box to write to the app's agents, and their answers — or directly to
// the app's language model with live streaming updates when the app links a
// model with no inbox agent.
//
// Add it to any app with three lines in its app.html, beside a model (std/llm/):
//
//   <link rel="agent" href="/std/agents/assistant.agent.md">
//   <link rel="plugin" href="/std/agents/chat.js">
//   <slot name="chat"></slot>
//
// When talking to an agent, it sends with `bus:send:*`: a message is
// information for the agent, never permission, so an agent still may do only
// what its own file allows. When asking a model directly (no inbox agent in
// the app), it calls `llm.stream` and updates the reply live as `llm:chunk`
// events arrive.

export const manifest = {
  id: "chat",
  name: "Chat",
  description: "Write to the app's agents, such as the assistant or the builder, and read their answers.",
  version: "1.1.0",
  permissions: ["ui", "bus:send:*", "llm", "plugins:read"],
  services: ["agents", "bus", "llm"],
  // Each tab has its own conversation.
  scope: "tab",
  // Where it draws on a page with no `chat` slot, when a person adds it to an app.
  places: { chat: { at: "main", put: "append" } },
  // Copied with it when a person adds it to an app.
  files: ["chat.html"],
};

/** The lines of the conversation it keeps, and how many go with each message. */
const KEEP = 40;
const CONTEXT = 8;
const DIRECT = "llm:direct";
const STREAM = "stream";

export default function (ctx) {
  const views = ctx.ui.views("chat.html");
  /** The agents with an inbox: { id, name, description }, or the direct model target when there are none. */
  let agents = [];
  let inboxCount = 0;
  let picked = "";
  /** { n, who, text, tone, from, to? }: who is "You" or an agent/model's name; from is "you" or the target's id. */
  const lines = [];
  let next = 0;
  let sending = false;
  /** The models to pick from: [{ id, name, label, picked }]. */
  let models = [];
  let activeStream = null;
  let streamTimer;

  const say = (who, text, tone, from, to) => {
    const entry = { n: ++next, who, text, tone, from, to };
    lines.push(entry);
    lines.splice(0, Math.max(0, lines.length - KEEP));
    return entry;
  };
  const draw = () => {
    const agent = agents.find((a) => a.id === picked);
    views.render("chat", "chat", {
      agents: agents.map((a) => ({ ...a, picked: a.id === picked })),
      none: !agents.length,
      models: models.length > 1 ? models.map(({ id, label, picked: p }) => ({ id, name: label, picked: p })) : [],
      about: agent?.description ?? "",
      lines,
      sending,
      name: agent?.name ?? "",
    });
  };
  /** The app's language models, for the picker and for direct chat when the app has no inbox agent. */
  const readModels = async () => {
    const list = await ctx.call("llm", "providers").catch(() => []);
    const on = list.find((p) => p.preferred) ?? list.find((p) => p.ready) ?? list[0];
    models = list.map((p) => ({
      id: p.id,
      rawName: p.name,
      label: p.ready ? p.name : `${p.name} (asks for your key)`,
      picked: p === on,
    }));
  };
  /** Looks for agents again; resolves to how many inbox agents it found. */
  const look = async () => {
    await readModels();
    const list = await ctx.call("agents", "list").catch(() => []);
    const inbox = list.filter((a) => a.inbox).map(({ id, name, description }) => ({ id, name, description }));
    inboxCount = inbox.length;
    if (inbox.length) {
      agents = inbox;
    } else if (models.length) {
      const current = models.find((m) => m.picked) ?? models[0];
      agents = [{ id: DIRECT, name: current.rawName, description: "Write directly to the language model." }];
    } else {
      agents = [];
    }
    if (!agents.some((a) => a.id === picked)) picked = agents.find((a) => a.id === "assistant")?.id ?? agents[0]?.id ?? "";
    draw();
    return inboxCount;
  };

  ctx.on("llm:chunk", (chunk) => {
    if (!activeStream || chunk?.streamId !== activeStream.id || chunk.done || !chunk.delta) return;
    if (!activeStream.line) {
      activeStream.line = say(activeStream.who, chunk.delta, "accent", DIRECT);
      draw();
      return;
    }
    activeStream.line.text += chunk.delta;
    if (!streamTimer) {
      streamTimer = setTimeout(() => {
        streamTimer = undefined;
        if (activeStream) draw();
      }, 30);
    }
  });

  const sendDirect = async (message, target) => {
    const history = lines
      .filter((l) => l.to === DIRECT || l.from === DIRECT)
      .slice(-CONTEXT)
      .map((l) => ({ role: l.from === "you" ? "user" : "assistant", content: l.text }));
    while (history.length && history[0].role !== "user") history.shift();
    say("You", message, "", "you", DIRECT);
    sending = true;
    draw();
    const streamId = crypto.randomUUID();
    activeStream = { id: streamId, who: target.name, line: null };
    try {
      const reply = await ctx.call("llm", STREAM, {
        streamId,
        messages: [...history, { role: "user", content: message }],
      });
      clearTimeout(streamTimer);
      streamTimer = undefined;
      const line = activeStream?.line;
      activeStream = null;
      const finalText = reply.text || "(No answer.)";
      if (line) {
        line.text = finalText;
      } else {
        say(target.name, finalText, "accent", DIRECT);
      }
    } catch (error) {
      clearTimeout(streamTimer);
      streamTimer = undefined;
      const line = activeStream?.line;
      activeStream = null;
      const errText = error instanceof Error ? error.message : String(error);
      if (line) {
        line.text = errText;
        line.tone = "danger";
      } else {
        say(target.name, errText, "danger", DIRECT);
      }
    }
    sending = false;
    draw();
  };

  const send = async (text) => {
    const message = String(text ?? "").trim().slice(0, 4000);
    const agent = agents.find((a) => a.id === picked);
    if (!message || !agent || sending) return;
    if (agent.id === DIRECT) return sendDirect(message, agent);
    const conversation = lines.filter((l) => l.to === agent.id || l.from === agent.id).slice(-CONTEXT).map((l) => ({ from: l.from, text: l.text }));
    say("You", message, "", "you", agent.id);
    sending = true;
    draw();
    try {
      const answer = await ctx.call("bus", "send", agent.id, { text: message, ...(conversation.length ? { data: { conversation } } : {}) }, { reply: true });
      const stopped = answer.stopReason !== "completed";
      say(agent.name, answer.text || (stopped ? `It stopped (${answer.stopReason}).` : "(No answer.)"), stopped ? "warn" : "accent", agent.id);
    } catch (error) {
      say(agent.name, error instanceof Error ? error.message : String(error), "danger", agent.id);
    }
    sending = false;
    draw();
  };

  // Agents start beside it, some a little later: look again until no more come.
  (async () => {
    let last = -1;
    for (const wait of [0, 500, 1000, 2000, 4000]) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      const found = await look();
      if (found && found === last) return;
      last = found;
    }
  })();

  // An agent the person adds or removes while the chat is open: the list follows, once the agent has started.
  ctx.on("plugins:changed", () => [0, 500, 1500].forEach((wait) => setTimeout(() => look().catch(() => {}), wait)));

  ctx.ui.onEvent(async (action, value) => {
    if (action === "agent" && typeof value === "string") {
      picked = value;
      return draw();
    }
    if (action === "model" && typeof value === "string") {
      // The person's pick, for every app: the one that answers until they pick another.
      await ctx.call("llm", "prefer", value).catch(() => {});
      await look();
      return;
    }
    if (action === "send") {
      await look();
      await send(value?.text);
    }
  });
}
