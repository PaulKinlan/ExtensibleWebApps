// The `agents` service: agents run here, and the app hears what they do.
//
// An agent is a Markdown file an app links with <link rel="agent">, which the
// kernel turns into a plugin running the agent loop (src/kernel/agents/). The
// loop reaches the model and its tools through this service, not `llm` and
// `tools` directly, so the kernel, not the agent, counts each run and token
// against the agent's limits and says what happened:
//
//   agent:wake        a run began: { agent, run, trigger: { kind, name } }
//   agent:toolResult  the agent called a tool: { agent, run, tool, ok }
//   agent:done        a run ended: { agent, run, stopReason, steps, tools, usage }
//                     stopReason: completed | steps | budget | error
//   agent:budget      an agent reached a limit, so a run didn't start or stopped:
//                     { agent, limit: "runs-per-hour" | "tokens-per-day", used, max }
//
// They say what an agent did, never the data it saw or wrote: a listener may
// not be allowed to read that. Any plugin may listen to them with
// hook:listen:agent:<name>. A plugin may
// also start an agent's command, if its manifest has `agents:run:<agent id>`:
//
//   await ctx.call("agents", "run", "shelf-tagger", "tag-untagged-books");
//
// Found by name: this file is src/kernel/services/agents.ts, so it is `ctx.call("agents", …)`.

import { made, type AgentConfig } from "../agents/file";
import { defineHook } from "../hooks";
import { callService, type ServiceProvider } from "../remote";
import { record } from "../trace";
import type { Kernel } from "./index";

const base = (instance: string) => instance.split("@")[0];
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const HOUR = 3_600_000;
const today = () => new Date().toISOString().slice(0, 10);

/** What an agent has used: runs in the hour that began at `hour`, tokens on `day`. */
type Usage = { hour: number; runs: number; day: string; tokens: number };
type Run = { agent: string; instance: string; tools: number; usage: { input: number; output: number } };

export default ({ root, remote, store }: Kernel): ServiceProvider => {
  defineHook("agent:run", { mode: "emit", needs: "agent", args: "{ agent }", description: "Someone ran one of an agent's commands (agents.run). The named agent fetches it with agents.next, which only that agent may call." });
  defineHook("agent:wake", { mode: "emit", args: "{ agent, run, trigger: { kind, name } }", description: "An agent began a run, woken by a hook or a command." });
  defineHook("agent:toolResult", { mode: "emit", args: "{ agent, run, tool, ok }", description: "An agent called one of its tools; ok is false if the call failed." });
  defineHook("agent:done", { mode: "emit", args: "{ agent, run, stopReason, steps, tools, usage: { input, output } }", description: "An agent's run ended. stopReason is completed, steps (it reached its step limit), budget or error." });
  defineHook("agent:budget", { mode: "emit", args: '{ agent, limit: "runs-per-hour" | "tokens-per-day", used, max }', description: "An agent reached one of its limits, so a run didn't start or was stopped." });

  const FILE = "agents/usage.json";
  /** Each agent's use, kept with the app's data so a reload doesn't reset its limits. */
  // A record with no prototype, so an agent called `constructor` gets its own entry.
  const used = store.readJson<unknown>(FILE, {}).then((u) => Object.assign(Object.create(null), isObject(u) ? u : {}) as Record<string, Usage>);
  const runs = new Map<string, Run>();
  /** Commands waiting for each agent, until it fetches them with `next`. */
  const commands = new Map<string, { command: string; input: unknown; from: string }[]>();
  let nextRun = 0;

  /** The agent an instance runs as, if the kernel made it from an agent file. */
  const agentOf = (instance: string): AgentConfig | undefined => {
    const source = remote.installed.get(base(instance))?.source;
    return source === undefined ? undefined : made.get(source);
  };
  const runOf = (instance: string, run: unknown): Run => {
    const r = typeof run === "string" ? runs.get(run) : undefined;
    if (!r || r.instance !== instance) throw new Error("Not a run of this agent");
    return r;
  };
  async function usage(agent: string): Promise<Usage> {
    const all = await used;
    const now = Math.floor(Date.now() / HOUR) * HOUR;
    if (!Object.hasOwn(all, agent) || !isObject(all[agent])) all[agent] = { hour: now, runs: 0, day: today(), tokens: 0 };
    const u = all[agent];
    if (u.hour !== now) Object.assign(u, { hour: now, runs: 0 });
    if (u.day !== today()) Object.assign(u, { day: today(), tokens: 0 });
    return u;
  }
  const save = async () => store.writeJson(FILE, await used).catch(() => {});
  /** The limit an agent has reached, if any, said in the agent:budget event. */
  function over(config: AgentConfig, u: Usage, starting: boolean, dispatch: { trace?: string }) {
    const hit = starting && u.runs >= config.limits.runsPerHour ? { limit: "runs-per-hour", used: u.runs, max: config.limits.runsPerHour } : u.tokens >= config.limits.tokensPerDay ? { limit: "tokens-per-day", used: u.tokens, max: config.limits.tokensPerDay } : undefined;
    if (hit) root.emit(dispatch, "agent:budget", { agent: config.id, ...hit });
    return !!hit;
  }

  return {
    description: "Agents: Markdown files an app links with rel=\"agent\", each run by the kernel as a plugin that asks a model and calls tools. Lists them, starts their commands, and is how an agent reaches its model and tools, so its limits hold and the app hears the agent:* events.",
    methods: {
      list: { args: "()", returns: "[{ id, name, hooks, commands, inbox, topics, limits, used: { runs, tokens } }]", description: "The agents running now, what wakes them, their limits, and what they have used this hour (runs) and today (tokens)." },
      run: { args: "(agent, command, input?)", returns: "{ ok: true }", needs: "agents:run:<agent>", description: "Starts one of an agent's commands, the ones its file lists under `on`. It runs after any run under way; listen to agent:done for the outcome." },
      next: { args: "()", returns: "[{ command, input, from }]", description: "For agents: the commands waiting for this agent, which it runs in order." },
      begin: { args: "(trigger)", returns: "{ ok: true, run } or { ok: false, reason }", description: "For agents: starts a run, if the agent is within its limits. The agent loop calls it." },
      complete: { args: "(run, request)", returns: "llm.complete's answer with ok: true, or { ok: false, reason }", description: "For agents: llm.complete, counted against the agent's tokens a day." },
      tool: { args: "(run, name, args)", returns: "{ ok, value?, error? }", description: "For agents: tools.call, as the agent, told to the app as agent:toolResult." },
      end: { args: "(run, { stopReason, text, steps })", returns: "true", description: "For agents: ends a run, told to the app as agent:done." },
    },
    capability: (method, args) => (method === "run" ? `agents:run:${String(args[0])}` : undefined),
    call: async (instance, method, args, dispatch) => {
      if (method === "list") {
        const out = [];
        for (const plugin of remote.installed.values()) {
          const config = made.get(plugin.source);
          if (!config || !plugin.enabled) continue;
          const u = await usage(config.id);
          out.push({ id: config.id, name: config.name, hooks: config.hooks, commands: config.commands, inbox: config.inbox, topics: config.topics, limits: config.limits, used: { runs: u.runs, tokens: u.tokens } });
        }
        return out;
      }
      if (method === "run") {
        const [agent, command, input] = args;
        const plugin = remote.installed.get(String(agent));
        const config = plugin && made.get(plugin.source);
        if (!config || !plugin.enabled) throw new Error(`No agent ${String(agent)} is running`);
        if (!config.commands.includes(command as string)) throw new Error(`${config.name} has no command ${String(command)}`);
        const waiting = commands.get(config.id) ?? [];
        if (waiting.length >= 20) throw new Error(`${config.name} has too many commands waiting`);
        waiting.push({ command: command as string, input, from: base(instance) });
        commands.set(config.id, waiting);
        // Only the agent's name goes out: whoever else holds `agent` learns nothing of the command or its input.
        root.emit(dispatch, "agent:run", { agent: config.id });
        return { ok: true };
      }

      // The rest are the agent loop's own: only an agent may call them, for its own runs.
      const config = agentOf(instance);
      if (!config) throw new Error(`agents.${method} is for agents`);
      const caps = remote.installed.get(base(instance))!.caps;

      if (method === "next") {
        const waiting = commands.get(config.id) ?? [];
        commands.delete(config.id);
        return waiting;
      }
      if (method === "begin") {
        const [trigger] = args;
        const u = await usage(config.id);
        if (over(config, u, true, dispatch)) return { ok: false, reason: "budget" };
        u.runs++;
        void save();
        const run = `${config.id}-${++nextRun}`;
        runs.set(run, { agent: config.id, instance, tools: 0, usage: { input: 0, output: 0 } });
        const t = isObject(trigger) ? trigger : {};
        root.emit(dispatch, "agent:wake", { agent: config.id, run, trigger: { kind: String(t.kind), name: String(t.name) } });
        return { ok: true, run };
      }
      if (method === "complete") {
        const r = runOf(instance, args[0]);
        const u = await usage(config.id);
        if (over(config, u, false, dispatch)) return { ok: false, reason: "budget" };
        const answer = (await callService(remote.services, instance, caps, "llm", "complete", [args[1]], dispatch)) as Record<string, any>;
        const input = Number(answer?.usage?.input) || 0;
        const output = Number(answer?.usage?.output) || 0;
        r.usage.input += input;
        r.usage.output += output;
        u.tokens += input + output;
        void save();
        return { ok: true, ...answer };
      }
      if (method === "tool") {
        const r = runOf(instance, args[0]);
        const [, name, toolArgs] = args;
        r.tools++;
        let result: { ok: boolean; value?: unknown; error?: string };
        try {
          result = { ok: true, value: await callService(remote.services, instance, caps, "tools", "call", [name, toolArgs], dispatch) };
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        root.emit(dispatch, "agent:toolResult", { agent: config.id, run: args[0], tool: name, ok: result.ok });
        return result;
      }
      if (method === "end") {
        const r = runOf(instance, args[0]);
        runs.delete(args[0] as string);
        const e = isObject(args[1]) ? args[1] : {};
        const stopReason = ["completed", "steps", "budget", "error"].includes(e.stopReason as string) ? e.stopReason : "error";
        // The model's last words stay in the trace, for the person; listeners hear only how the run ended.
        if (e.text) record({ kind: "lifecycle", name: "agent:done", plugin: config.id, detail: String(e.text).slice(0, 2000) });
        root.emit(dispatch, "agent:done", { agent: config.id, run: args[0], stopReason, steps: Number(e.steps) || 0, tools: r.tools, usage: r.usage });
        return true;
      }
      throw new Error(`agents.${method} is not a method`);
    },
  };
};
