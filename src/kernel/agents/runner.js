// The agent loop. The kernel puts this after the manifest and the AGENT
// constant it makes from an agent file (file.ts), so every agent runs the
// same loop in its own plugin worker, held to its own manifest.
//
// Something wakes the agent: a hook it listens to, or a command someone runs
// (agents.run). Each wake is one run: the agent asks the model, with its
// instructions as the system prompt and its tools (tools.list: what its
// manifest lets it call), then calls the tools the model picks and gives the
// model their answers, until the model stops or the run reaches its step
// limit. Runs go one at a time, in the order they woke the agent.
//
// The model and the tools are reached through the `agents` service rather
// than `llm` and `tools` directly, so the kernel counts every run and token
// against the agent's limits and tells the app what the agent did, in the
// agent:* events, whatever this code says.

/** Woken by its own writes, an agent would wake itself forever: the change a write of its own makes, within a minute, is not news. */
const ECHO_MS = 60_000;
/** Wakes that wait while a run is under way; past this, the oldest are dropped. */
const QUEUE = 20;
/** The most of a tool's answer the model sees. */
const ANSWER = 20_000;

export default async function (ctx) {
  const queue = [];
  let running = false;
  /** For each `collection/id` this agent wrote: what it wrote (null for a delete), and when. */
  const wrote = new Map();

  function wake(trigger) {
    queue.push(trigger);
    if (queue.length > QUEUE) ctx.log(`${AGENT.name}: too much to do; skipped ${queue.shift().name}`, "error");
    if (!running) void drain();
  }

  async function drain() {
    running = true;
    while (queue.length) {
      const trigger = queue.shift();
      // Checked here, not when the change arrives: the change a tool call makes can arrive before the call's answer.
      if (trigger.kind === "hook" && trigger.name.startsWith("data:changed:") && echo(trigger.value)) continue;
      try {
        await run(trigger);
      } catch (error) {
        ctx.log(`${AGENT.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
    running = false;
  }

  /** What woke the agent, as the first message of the run. */
  function describe(trigger) {
    const value = JSON.stringify(trigger.value ?? null, null, 2).slice(0, ANSWER);
    if (trigger.kind === "hook") return `The app's \`${trigger.name}\` event happened, with:\n\n\`\`\`json\n${value}\n\`\`\`\n\nDo what your instructions say for it. If there is nothing to do, say so in a sentence.`;
    return `You were asked to run \`${trigger.name}\`${trigger.from ? ` by ${trigger.from}` : ""}${trigger.value === undefined ? "" : `, with:\n\n\`\`\`json\n${value}\n\`\`\``}\n\nDo what your instructions say for it.`;
  }

  async function run(trigger) {
    const begun = await ctx.call("agents", "begin", { kind: trigger.kind, name: trigger.name });
    if (!begun.ok) return ctx.log(`${AGENT.name}: didn't run: ${begun.reason}`);
    const runId = begun.run;
    const tools = (await ctx.call("tools", "list")).slice(0, 64).map(({ name, description, parameters }) => ({ name, description, parameters }));
    const messages = [{ role: "user", content: describe(trigger) }];
    let text = "";
    let stopReason = "completed";
    let steps = 0;
    try {
      for (;;) {
        if (steps++ >= AGENT.limits.steps) {
          stopReason = "steps";
          break;
        }
        const answer = await ctx.call("agents", "complete", runId, { system: AGENT.instructions, messages, tools, model: AGENT.model });
        if (!answer.ok) {
          stopReason = answer.reason;
          break;
        }
        messages.push(answer.message);
        text = answer.text ?? "";
        if (!answer.toolCalls?.length) break;
        for (const call of answer.toolCalls) {
          const result = await ctx.call("agents", "tool", runId, call.name, call.args ?? {});
          if (result.ok) remember(call.name, call.args, result.value);
          const content = result.ok ? JSON.stringify(result.value ?? null) : `Error: ${result.error}`;
          messages.push({ role: "tool", id: call.id, name: call.name, content: content.slice(0, ANSWER) });
        }
      }
    } catch (error) {
      stopReason = "error";
      text = error instanceof Error ? error.message : String(error);
    }
    await ctx.call("agents", "end", runId, { stopReason, text, steps: Math.min(steps, AGENT.limits.steps) });
  }

  /** Notes a write this agent made, once it is committed, so the change it causes doesn't wake it again. */
  function remember(tool, args, value) {
    const m = /^data_(put|delete)(?:_(.+))?$/.exec(tool);
    if (!m || value?.ok !== true || !value.id) return;
    const collection = m[2] ?? args.collection;
    if (!collection) return;
    const fields = m[1] === "put" ? Object.fromEntries(Object.entries(args.record ?? {}).filter(([k]) => k !== "id")) : null;
    wrote.set(`${collection}/${value.id}`, { fields, at: Date.now() });
  }

  /** True only for the change this agent's own write made: the same record, with what it wrote. Anyone else's edit is news. */
  function echo(change) {
    for (const [k, w] of wrote) if (Date.now() - w.at > ECHO_MS) wrote.delete(k);
    const key = `${change?.collection}/${change?.id}`;
    const w = wrote.get(key);
    if (!w) return false;
    const after = change.after;
    const same = w.fields === null
      ? after === undefined
      : !!after && Object.entries(w.fields).every(([k, v]) => (v === null || v === "" ? after[k] === undefined : JSON.stringify(after[k]) === JSON.stringify(v)));
    // One write makes one change: once it is matched, the next change to the record wakes the agent.
    if (same) wrote.delete(key);
    return same;
  }

  for (const hook of AGENT.hooks) {
    ctx.on(hook, (value) => wake({ kind: "hook", name: hook, value }));
  }
  // A command someone ran (agents.run). The event only names the agent; the command and its input are
  // fetched from the kernel, which hands them only to the agent it made from this file.
  ctx.on("agent:run", async (request) => {
    if (request?.agent !== AGENT.id) return;
    for (const c of await ctx.call("agents", "next")) wake({ kind: "command", name: c.command, value: c.input, from: c.from });
  });
}
