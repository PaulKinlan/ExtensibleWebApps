// Chat: a box to write to the app's agents, and their answers. It lists the
// agents the app links that have an inbox (`- message: true` in their file),
// such as the standard assistant and builder beside it, and sends what the
// person writes to the one they pick, waiting for the answer.
//
// Add it to any app with three lines in its app.html, beside a model (std/llm/):
//
//   <link rel="agent" href="/std/agents/assistant.agent.md">
//   <link rel="plugin" href="/std/agents/chat.js">
//   <slot name="chat"></slot>
//
// It sends with `bus:send:*`: a message is information for the agent, never
// permission, so an agent still may do only what its own file allows. The
// last few lines of the conversation go with each message, as its data, so
// the agent knows what "that one" means.

export const manifest = {
  id: "chat",
  name: "Chat",
  description: "Write to the app's agents, such as the assistant or the builder, and read their answers.",
  version: "1.0.0",
  permissions: ["ui", "bus:send:*"],
  // Each tab has its own conversation.
  scope: "tab",
};

/** The lines of the conversation it keeps, and how many go with each message. */
const KEEP = 40;
const CONTEXT = 8;

export default function (ctx) {
  const views = ctx.ui.views("chat.html");
  /** The agents with an inbox: { id, name, description, picked }. */
  let agents = [];
  let picked = "";
  /** { n, who, text, tone, from, to? }: who is "You" or an agent's name; from is "you" or the agent's id, and to the agent a line of yours went to. */
  const lines = [];
  let next = 0;
  let sending = false;

  const say = (who, text, tone, from, to) => {
    lines.push({ n: ++next, who, text, tone, from, to });
    lines.splice(0, Math.max(0, lines.length - KEEP));
  };
  const draw = () => {
    const agent = agents.find((a) => a.id === picked);
    views.render("chat", "chat", { agents: agents.map((a) => ({ ...a, picked: a.id === picked })), none: !agents.length, about: agent?.description ?? "", lines, sending, name: agent?.name ?? "" });
  };
  /** Looks for agents again; resolves to how many it found. */
  const look = async () => {
    const list = await ctx.call("agents", "list").catch(() => []);
    agents = list.filter((a) => a.inbox).map(({ id, name, description }) => ({ id, name, description }));
    if (!agents.some((a) => a.id === picked)) picked = agents.find((a) => a.id === "assistant")?.id ?? agents[0]?.id ?? "";
    draw();
    return agents.length;
  };

  const send = async (text) => {
    const message = String(text ?? "").trim().slice(0, 4000);
    const agent = agents.find((a) => a.id === picked);
    if (!message || !agent || sending) return;
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

  ctx.ui.onEvent(async (action, value) => {
    if (action === "agent" && typeof value === "string") {
      picked = value;
      return draw();
    }
    if (action === "send") {
      await look();
      await send(value?.text);
    }
  });
}
