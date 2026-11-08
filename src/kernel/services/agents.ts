// The `agents` service: agents run here, and the app hears what they do.
//
// An agent is a Markdown file an app links with <link rel="agent">, which the
// kernel turns into a plugin running the agent loop (src/kernel/agents/). The
// loop reaches the model and its tools through this service, not `llm` and
// `tools` directly, so the kernel, not the agent, counts each run and token
// against the agent's limits and says what happened:
//
//   agent:wake        a run began: { agent, run, trigger: { kind, name }, as? }
//                     as: "person" when the agent acts for the person in this run
//   agent:toolResult  the agent called a tool: { agent, run, tool, ok }
//   agent:done        a run ended: { agent, run, stopReason, steps, tools, usage, verdict? }
//                     stopReason: completed | steps | budget | error | timeout;
//                     verdict, for a check: allow | block
//   agent:beforeTool  an agent is about to call a tool: { agent, run, tool, args }.
//                     A listener (a security agent, say) may return { block: reason }.
//   agent:budget      an agent reached a limit, so a run didn't start or stopped:
//                     { agent, limit: "runs-per-hour" | "tokens-per-day", used, max }
//
// They say what an agent did, never the data it saw or wrote: a listener may
// not be allowed to read that. Any plugin may listen to them with
// hook:listen:agent:<name>. agent:beforeTool is the exception: it carries the
// tool's arguments, so that something can check them, and listening to it
// needs hook:intercept:agent:beforeTool. A plugin may
// also start an agent's command, if its manifest has `agents:run:<agent id>`:
//
//   await ctx.call("agents", "run", "shelf-tagger", "tag-untagged-books");
//
// An agent whose file says `acts-as: person` may act for the person in a
// run they asked for: a message from a plugin (a chat, say) rather than
// another agent, or one of its commands. The first time, and every time
// until they choose "Always", a card asks them. In a run where it acts for
// them, its tool calls carry its id as `via`, so the review cards and the
// change log say the changes are the person's, made through the agent. They
// are still reviewed, and it may still do only what its own permissions
// allow: its rights are its own list, capped by the person's, and with one
// person, who may do anything in their own app, that cap is everything.
//
// Found by name: this file is src/kernel/services/agents.ts, so it is `ctx.call("agents", …)`.

import { made, type AgentConfig } from "../agents/file";
import { BEFORE_WRITE, defineHook, hooks } from "../hooks";
import { callService, type ServiceProvider } from "../remote";
import { ACTS_AS } from "../review";
import { record } from "../trace";
import type { Kernel } from "./index";

const base = (instance: string) => instance.split("@")[0];
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const HOUR = 3_600_000;
const today = () => new Date().toISOString().slice(0, 10);

/** What an agent has used: runs in the hour that began at `hour`, tokens on `day`. */
type Usage = { hour: number; runs: number; day: string; tokens: number };
type Run = {
  agent: string;
  instance: string;
  tools: number;
  usage: { input: number; output: number };
  /** For a check: the agents whose tool call it checks, and this one; their calls aren't checked by them again. */
  chain: string[];
  /** For a check: when the action stops waiting for it. */
  timer?: ReturnType<typeof setTimeout>;
  /** Whether the agent acts for the person in this run (acts-as: person, and they let it). */
  acting: boolean;
};

export default ({ root, remote, store, reviewed, apps }: Kernel): ServiceProvider => {
  defineHook("agent:run", { mode: "emit", needs: "agent", args: "{ agent }", description: "Someone ran one of an agent's commands (agents.run). The named agent fetches it with agents.next, which only that agent may call." });
  defineHook("agent:wake", { mode: "emit", args: "{ agent, run, trigger: { kind, name }, as? }", description: "An agent began a run. kind is hook, check (it was asked whether something may happen), command, message or topic. as is \"person\" when it acts for the person in this run (acts-as: person)." });
  defineHook("agent:beforeTool", { mode: "serial", timeoutMs: 1000, agentTimeoutMs: 15_000, onFailure: "open", args: "{ agent, run, tool, args, chain }", description: "An agent is about to call one of its tools, with these arguments. chain is the agents in the call's line: the caller, and any agents whose tool call it is checking. Return { block: reason } to stop the call; the agent hears the reason." });
  defineHook("agent:toolResult", { mode: "emit", args: "{ agent, run, tool, ok }", description: "An agent called one of its tools; ok is false if the call failed." });
  defineHook("agent:done", { mode: "emit", args: "{ agent, run, stopReason, steps, tools, usage: { input, output }, verdict? }", description: "An agent's run ended. stopReason is completed, steps (it reached its step limit), budget, error or timeout (a check that ran out of time). A check's run says its verdict: allow or block." });
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
  /** True for a plugin the kernel made from an agent file. */
  const isAgent = (id: string) => {
    const source = remote.installed.get(id)?.source;
    return source !== undefined && made.has(source);
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

  /** Ends a run, once: by the agent (agents.end), or by the kernel when a check runs out of time. */
  function finish(run: string, e: Record<string, unknown>, dispatch: { trace?: string }) {
    const r = runs.get(run);
    if (!r) return;
    runs.delete(run);
    clearTimeout(r.timer);
    const stopReason = ["completed", "steps", "budget", "error", "timeout"].includes(e.stopReason as string) ? e.stopReason : "error";
    // The model's last words stay in the trace, for the person; listeners hear only how the run ended.
    if (e.text) record({ kind: "lifecycle", name: "agent:done", plugin: r.agent, detail: String(e.text).slice(0, 2000) });
    const verdict = e.verdict === "allow" || e.verdict === "block" ? { verdict: e.verdict } : {};
    root.emit(dispatch, "agent:done", { agent: r.agent, run, stopReason, steps: Number(e.steps) || 0, tools: r.tools, usage: r.usage, ...verdict });
  }

  return {
    description: "Agents: Markdown files an app links with rel=\"agent\", each run by the kernel as a plugin that asks a model and calls tools. Lists them, starts their commands, and is how an agent reaches its model and tools, so its limits hold and the app hears the agent:* events.",
    methods: {
      list: { args: "()", returns: "[{ id, name, description, actsAs, hooks, checks, commands, inbox, topics, limits, used: { runs, tokens } }]", description: "The agents running now in the caller's app (every one, for a plugin no app links), what wakes them, their limits, and what they have used this hour (runs) and today (tokens)." },
      run: { args: "(agent, command, input?)", returns: "{ ok: true }", needs: "agents:run:<agent>", description: "Starts one of an agent's commands, the ones its file lists under `on`. It runs after any run under way; listen to agent:done for the outcome." },
      next: { args: "()", returns: "[{ command, input, from }]", description: "For agents: the commands waiting for this agent, which it runs in order." },
      begin: { args: "(trigger)", returns: "{ ok: true, run } or { ok: false, reason }", description: "For agents: starts a run, if the agent is within its limits. The agent loop calls it." },
      complete: { args: "(run, request)", returns: "llm.complete's answer with ok: true, or { ok: false, reason }", description: "For agents: llm.complete, counted against the agent's tokens a day." },
      tool: { args: "(run, name, args)", returns: "{ ok, value?, error? }", description: "For agents: tools.call, as the agent, told to the app as agent:toolResult." },
      end: { args: "(run, { stopReason, text, steps, verdict? })", returns: "true", description: "For agents: ends a run, told to the app as agent:done." },
    },
    capability: (method, args) => (method === "run" ? `agents:run:${String(args[0])}` : undefined),
    call: async (instance, method, args, dispatch) => {
      if (method === "list") {
        // The caller's app: its tab's, or the apps that link it; a plugin no app links sees every agent.
        const tab = instance.split("@")[1];
        const linked = tab ? apps.linkedBy(tab) : undefined;
        const app = linked ? new Set(linked) : apps.alongside(instance);
        const out = [];
        for (const plugin of remote.installed.values()) {
          const config = made.get(plugin.source);
          if (!config || !plugin.enabled || (app && !app.has(config.id))) continue;
          const u = await usage(config.id);
          out.push({ id: config.id, name: config.name, description: plugin.manifest.description ?? "", actsAs: config.actsAs, hooks: config.hooks, checks: config.checks, commands: config.commands, inbox: config.inbox, topics: config.topics, limits: config.limits, used: { runs: u.runs, tokens: u.tokens } });
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
        const t = isObject(trigger) ? trigger : {};
        const chain = Array.isArray(t.chain) ? t.chain.filter((a): a is string => typeof a === "string").slice(0, 8) : [];
        // Acting for the person: only in a run they asked for, a message or a command from a plugin rather than an agent, and once they let it.
        const from = t.kind === "message" ? String(t.name) : typeof t.from === "string" ? t.from : "";
        const asked = (t.kind === "message" || t.kind === "command") && !!from && !isAgent(from);
        const why = t.kind === "message" ? `You sent it a message through ${remote.installed.get(from)?.manifest.name ?? from}.` : `${remote.installed.get(from)?.manifest.name ?? from} ran its ${String(t.name)} command.`;
        const acting = config.actsAs === "person" && asked && (await reviewed(instance, ACTS_AS, "who its changes are made as", "", "", why, dispatch).then(() => true, () => false));
        const r: Run = { agent: config.id, instance, tools: 0, usage: { input: 0, output: 0 }, chain: [...new Set([...chain, config.id])], acting };
        runs.set(run, r);
        root.emit(dispatch, "agent:wake", { agent: config.id, run, trigger: { kind: String(t.kind), name: String(t.name) }, ...(acting ? { as: "person" } : {}) });
        // A check has as long as the hook gives an agent. Past it the action has gone on without it,
        // so the run ends there: what the model says later calls no tool and decides nothing.
        if (t.kind === "check") {
          const limit = (hooks.get(String(t.name)) ?? (String(t.name).startsWith("data:beforeWrite:") ? BEFORE_WRITE : undefined))?.agentTimeoutMs ?? 0;
          r.timer = setTimeout(() => finish(run, { stopReason: "timeout", steps: 0 }, dispatch), limit);
        }
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
        // Whoever checks agents' tool calls (a security agent) may stop this one first.
        const verdict = await root.serial(dispatch, "agent:beforeTool", { agent: config.id, run: args[0], tool: String(name), args: toolArgs ?? {}, chain: r.chain });
        if (isObject(verdict) && "block" in verdict) result = { ok: false, error: `Blocked: ${String(verdict.block)}` };
        else {
          try {
            // Acting for the person, its calls say so (`via`), so reviews and the change log name them, through it.
            const as = r.acting ? { ...dispatch, via: config.id } : dispatch;
            result = { ok: true, value: await callService(remote.services, instance, caps, "tools", "call", [name, toolArgs], as) };
          } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
        root.emit(dispatch, "agent:toolResult", { agent: config.id, run: args[0], tool: name, ok: result.ok });
        return result;
      }
      if (method === "end") {
        runOf(instance, args[0]);
        finish(args[0] as string, isObject(args[1]) ? args[1] : {}, dispatch);
        return true;
      }
      throw new Error(`agents.${method} is not a method`);
    },
  };
};
