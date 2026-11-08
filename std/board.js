// Board: where the app's agents reach the person. One panel, folded to a
// button with a badge until something waits: questions agents asked
// (bus.ask), each with its choices or a box to answer in, what is waiting
// while an agent checks it (a security agent, say), and what the agents did
// lately.
//
// Add it to any app with two lines in its app.html:
//
//   <link rel="plugin" href="/std/board.js">
//   <slot name="board"></slot>
//
// It answers only with what the person picks or writes. An answer is
// information for the agent that asked, never permission: the agent still
// can do only what its own manifest allows.

export const manifest = {
  id: "board",
  name: "Board",
  description: "Questions from the app's agents, waiting for your answer, and what they did lately.",
  version: "1.0.0",
  permissions: ["ui", "bus:board", "hook:listen:bus:asked", "hook:listen:bus:answered", "hook:listen:agent:*"],
  // One per tab, so opening the board in one tab doesn't open it in another.
  scope: "tab",
};

/** How many things the agents did that it keeps. */
const KEEP = 10;

export default function (ctx) {
  const views = ctx.ui.views("board.html");
  let open = false;
  let questions = [];
  /** Newest first: { id, text }. */
  const lately = [];
  /** Checks under way, by run: { run, agent, name }. Something waits for each. */
  const checking = new Map();
  let next = 0;

  const draw = () => views.render("board", "board", { open, questions, waiting: questions.length, lately, checking: [...checking.values()] });
  const refresh = async () => {
    questions = (await ctx.call("bus", "questions")).map((q) => ({ ...q, open: !q.choices }));
    // A new question opens the board: the agent is waiting for the person.
    if (questions.length) open = true;
    draw();
  };
  const did = (text) => {
    lately.unshift({ id: ++next, text });
    lately.length = Math.min(lately.length, KEEP);
    draw();
  };

  ctx.on("bus:asked", refresh);
  ctx.on("bus:answered", refresh);
  ctx.on("agent:wake", ({ agent, run, trigger }) => {
    // A check holds something up until the agent answers: show it as being checked.
    if (trigger.kind === "check") {
      checking.set(run, { run, agent, name: trigger.name });
      return draw();
    }
    did(`${agent} woke: ${trigger.kind === "message" ? `a message from ${trigger.name}` : trigger.name}`);
  });
  ctx.on("agent:done", ({ agent, run, stopReason, tools, verdict }) => {
    const check = checking.get(run);
    if (check) {
      checking.delete(run);
      return did(`${agent} ${verdict === "block" ? "blocked" : verdict === "allow" ? "allowed" : `couldn't check (${stopReason})`} ${check.name}`);
    }
    did(`${agent} ${stopReason === "completed" ? "finished" : `stopped (${stopReason})`} after ${tools} tool call${tools === 1 ? "" : "s"}`);
  });
  ctx.on("agent:budget", ({ agent, limit }) => did(`${agent} reached its ${limit} limit`));

  ctx.ui.onEvent(async (action, value) => {
    if (action === "toggle") {
      open = !open;
      return draw();
    }
    if (action === "answer" && value?.id && String(value.answer ?? "").trim()) {
      await ctx.call("bus", "answer", value.id, String(value.answer)).catch((error) => ctx.log(error.message, "error"));
      await refresh();
    }
  });
  void refresh();
}
