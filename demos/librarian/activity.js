// Activity: what the app's agents did, from the agent:* events the kernel
// sends. Any plugin may listen to them (hook:listen:agent:*); this one keeps
// the last few and lists them. It doesn't know which agents there are: it
// would list a second agent's runs too.

export const manifest = {
  id: "agent-activity",
  name: "Agent activity",
  description: "Lists what the app's agents did: each run, the tools they called, and how it ended.",
  version: "1.0.0",
  permissions: ["ui", "hook:listen:agent:*"],
  order: 30,
};

const KEEP = 12;

export default async function (ctx) {
  const views = ctx.ui.views("activity.html");
  /** Newest first: { id, kind, text, tone }. */
  const lines = [];
  let next = 0;
  const add = (kind, text, tone = "neutral") => {
    lines.unshift({ id: ++next, kind, text, tone });
    lines.length = Math.min(lines.length, KEEP);
    views.render("side", "activity", { lines });
  };

  ctx.on("agent:wake", ({ agent, trigger }) => add("woke", `${agent}: ${trigger.kind === "command" ? `asked to ${trigger.name}` : trigger.name}`, "accent"));
  ctx.on("agent:toolResult", ({ agent, tool, ok, error }) => add("tool", `${agent} called ${tool}${ok ? "" : `: ${error}`}`, ok ? "ok" : "danger"));
  ctx.on("agent:done", ({ agent, stopReason, text, usage }) =>
    add(stopReason === "completed" ? "done" : stopReason, `${agent}: ${text || "no answer"} (${usage.input + usage.output} tokens)`, stopReason === "completed" ? "neutral" : "warn"),
  );
  ctx.on("agent:budget", ({ agent, limit, used, max }) => add("limit", `${agent} reached its ${limit} limit: ${used} of ${max}`, "warn"));
  views.render("side", "activity", { lines });
}
