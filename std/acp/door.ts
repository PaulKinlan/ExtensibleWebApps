// What the `acp` door does (module.ts says what it is for): the agent's side
// of the Agent Client Protocol, version 1, for one of a space's agents.
//
// The host (src/server/acp.ts) hands in each JSON-RPC message an editor sent
// to /s/<space>/acp/<agent>, with the member whose key it carried:
//
//   initialize      which version and what the agent can take; makes a connection
//   session/new     a conversation, kept for the member
//   session/load    takes one up again, and says what was said in it
//   session/prompt  what the person wrote: one turn of the agent
//   session/cancel  stops the turn under way
//
// and asks, for the stream the editor keeps open, what there is to say since
// it last asked: `session/update` for what the agent says and each tool it
// calls, `session/request_permission` for a review, and the answer to each
// request. Everything for the editor is queued here with a number, kept until
// the stream says it got that far, so a stream that drops and comes back
// misses nothing.
//
// A turn is the standard agent loop (std/agents/runner.js), run here so each
// step can be told to the editor as it happens. The agent is still an
// ordinary plugin made from its file (src/kernel/agents/file.ts), started on
// the space's server with a loop that does nothing by itself: there it only
// answers an editor, so what wakes it in a browser (a hook, a command) doesn't
// also wake it here. Every model request and tool call goes through the
// `agents` service as that plugin, so its limits, the agent:* events, the
// gate and the reviews are the ones it has anywhere.
//
// The model is the one the space holds a key for (std/spaces/model-key.ts).
// The host hands in what unlocks the key with each prompt, and it is kept
// only while that turn runs.
//
// A review (a change to data the agent doesn't own, or letting it act for the
// person) goes to the members' open apps as always (std/spaces/reviews.ts).
// It is also asked in the editor, as session/request_permission, when the key
// the editor sent was made for it (`answers`): the first answer settles it.
// With any other key the editor is told where the card is waiting.
//
// Conversations are kept in the space's folder (acp/sessions/), each with the
// member it belongs to, so one can go on after the space's server slept.

import { env } from "../../src/kernel/env";
import { fromAgentFile, isOutsideFile, made, type AgentConfig } from "../../src/kernel/agents/file";
import type { ModuleKernel } from "../../src/kernel/modules";
import { callService } from "../../src/kernel/remote";
import { placeLabel, type Request as Review } from "../../src/kernel/review";
import type { RouteRequest, RouteResponse } from "../../src/kernel/routes";
import { record } from "../../src/kernel/trace";
import { isAgentFile, runnerName } from "../../src/shared/agent-runner";
import { pluginLinks } from "../spaces/server-apps";
import type { Tool } from "../tools/module";

/** The ACP version this speaks: a client asking for another is answered with this one. */
export const ACP_VERSION = 1;
/** The provider the agent's model requests name while an editor's turn runs: the space's own model. */
const PROVIDER = "acp-space-model";
/** The loop the agent's plugin runs here: none. Its turns are run by this door. */
const IDLE = "// On a space's server this agent only answers an editor (std/acp/door.ts).\nexport default function () {}\n";
const SESSIONS = "acp/sessions";
/** The most of a conversation kept and sent to the model, in characters: the oldest turns go first. */
const MAX_HISTORY = 300_000;
/** The most of one prompt, and of one tool's answer, the model sees. */
const MAX_PROMPT = 200_000;
const ANSWER = 20_000;
/** Messages kept for a stream that hasn't taken them yet; past this the oldest go. */
const MAX_QUEUE = 2000;
/** And the most they may take up together, in characters: past this the oldest go too. */
const MAX_QUEUE_SIZE = 8_000_000;
/** How long a turn may take, reviews included: a little under what the host waits (ACP_TURN_MS, src/server/acp.ts), so its answer still gets out. */
const TURN_MS = 29 * 60_000;
const MAX_CONNECTIONS = 100;
const CONNECTION_IDLE_MS = 24 * 3_600_000;
/** Conversations kept for a space, and for how long after they were last used. */
const MAX_SESSIONS = 200;
const SESSION_DAYS = 30;
/** How often a turn looks for a review to ask the editor about. */
const REVIEW_LOOK_MS = 150;
const HEX = /^[0-9a-f]{32}$/;
const SESSION_ID = /^[0-9a-z]{6,12}-[0-9a-f]{32}$/;

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
/** A message as the model takes it (std/llm/module.ts). */
type Message = Record<string, unknown> & { role: string };

/** What the host says of the member with each message. */
interface From {
  member: string;
  name: string;
  /** Whether the key was made for this editor and agent, so its prompt may answer the agent's reviews. */
  answers: boolean;
  /** What unlocks the space's model key, with a prompt. */
  lock?: string;
  gateways?: Record<string, string>;
}

interface Connection {
  agent: string;
  member: string;
  /** What waits for the stream, oldest first. */
  queue: { seq: number; message: unknown; size: number }[];
  /** How much the queue holds, in characters. */
  size: number;
  /** The stream the editor has open now: a newer one takes over. */
  stream?: string;
  /** Reviews asked in the editor: its request's id, to the review and the turn. */
  asked: Map<string, { review: string; turn: Turn }>;
  used: number;
}

interface Session {
  id: string;
  agent: string;
  member: string;
  messages: Message[];
  turn?: Turn;
}

interface Turn {
  session: Session;
  connection: Connection;
  cancelled: boolean;
  /** Settles when the turn is cancelled, so a model request under way isn't waited for. */
  stop: Promise<"cancelled">;
  cancel(): void;
  /** The tool call under way, which a review belongs to. */
  tool?: string;
  /** The agent it is running as, while it runs: not yet while it waits its place behind another turn. */
  running?: string;
  /** Reviews already told to the editor. */
  told: Set<string>;
  from: From;
}

interface Agent {
  config: AgentConfig;
  source: string;
  href: string;
  app: string;
}

const random = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const says = (error: unknown) => (error instanceof Error ? error.message : String(error));
const text = (value: string) => ({ type: "text", text: value });

/** A JSON-RPC error whose message is for the person: editors show it as it is. */
class Refusal extends Error {
  constructor(
    message: string,
    public code = -32000,
  ) {
    super(message);
  }
}

/** What the person wrote, as one text for the model: text, links to files, and files sent whole. */
function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) throw new Refusal("session/prompt needs `prompt`: a list of content blocks", -32602);
  const parts: string[] = [];
  for (const block of blocks) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "resource_link" && typeof block.uri === "string") parts.push(`[${typeof block.name === "string" && block.name ? block.name : block.uri}](${block.uri})`);
    else if (block.type === "resource" && isObject(block.resource) && typeof block.resource.text === "string") parts.push(`${String(block.resource.uri ?? "A file")}:\n\n\`\`\`\n${block.resource.text}\n\`\`\``);
    else parts.push(`(Something this agent can't read was left out: ${String(block.type)}.)`);
  }
  const all = parts.join("\n\n").trim();
  if (!all) throw new Refusal("There was nothing to read in that message: write the agent some text", -32602);
  if (all.length > MAX_PROMPT) throw new Refusal(`That message is more than this agent reads at once (${MAX_PROMPT.toLocaleString("en")} characters). Send less, or a part of the file.`, -32602);
  return all;
}

/** What kind of thing a tool does, as ACP names them, for the editor's icon. */
const kindOf = (tool: Tool | undefined) =>
  !tool ? "other" : /^(get|list|read|current|collections|mine|file|status)$/.test(tool.method) ? "read" : /^(search|find)$/.test(tool.method) ? "search" : /^(delete|remove)$/.test(tool.method) ? "delete" : /^(put|write|set|add|update)$/.test(tool.method) ? "edit" : tool.service === "net" ? "fetch" : "other";

/** A tool call's line in the editor: what the tool does, in a few words. */
const titleOf = (tool: Tool | undefined, name: string) => (tool?.description.split(/(?<=[.:])\s/)[0].replace(/[.:]$/, "").slice(0, 120) || name);

export function acpDoor(kernel: ModuleKernel) {
  const { root, remote, store, reviews } = kernel;
  const where = env();
  const fetcher = where.site ?? ((url: string) => fetch(url));
  const connections = new Map<string, Connection>();
  const sessions = new Map<string, Session>();
  /** The turns under way, by the trace their requests carry: how a model request finds whose key answers it. */
  const turns = new Map<string, Turn>();
  /** One turn at a time for each agent: a review is the agent's, so two turns' reviews couldn't be told apart. */
  const lines = new Map<string, Promise<unknown>>();
  let seq = 0;
  let stopped = false;

  // ---- The stream ----

  /** Queues a message for a connection's stream, and tells the host there is something to send. */
  function say(connection: Connection, message: unknown) {
    // Numbers only go up, across a restart too, so a stream that asks "after n" never misses or repeats.
    seq = Math.max(seq + 1, Date.now() * 1000);
    const size = JSON.stringify(message).length;
    connection.queue.push({ seq, message, size });
    connection.size += size;
    while (connection.queue.length > 1 && (connection.queue.length > MAX_QUEUE || connection.size > MAX_QUEUE_SIZE)) connection.size -= connection.queue.shift()!.size;
    where.changed?.("acp");
  }
  const update = (turn: Turn, body: Record<string, unknown>) => say(turn.connection, { jsonrpc: "2.0", method: "session/update", params: { sessionId: turn.session.id, update: body } });

  function connectionOf(id: string | undefined, agent: string, member: string): Connection | undefined {
    if (!id || !HEX.test(id)) return undefined;
    const now = Date.now();
    for (const [key, c] of connections) if (now - c.used > CONNECTION_IDLE_MS) connections.delete(key);
    let connection = connections.get(id);
    if (connection && (connection.agent !== agent || connection.member !== member)) return undefined;
    // Taken up again after the space's server slept: the editor isn't made to connect again for that.
    if (!connection) connection = admit(id, agent, member);
    connection.used = now;
    return connection;
  }

  function admit(id: string, agent: string, member: string): Connection {
    if (connections.size >= MAX_CONNECTIONS) {
      const oldest = [...connections.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      if (oldest) connections.delete(oldest[0]);
    }
    const connection: Connection = { agent, member, queue: [], size: 0, asked: new Map(), used: Date.now() };
    connections.set(id, connection);
    return connection;
  }

  // ---- The agents ----

  /** The space's agents an editor can talk to, by id, and those it can't, with why. */
  const agents = new Map<string, Agent>();
  const unfit = new Map<string, string>();
  const read = new Set<string>();
  let looked = 0;

  /** Reads the agent files of the apps opened in the space. */
  async function look() {
    const apps = (await kernel.lent()?.server?.list?.()) ?? [];
    for (const app of apps) {
      const base = `${where.origin.replace(/\/$/, "")}/${app}/`;
      const page = await fetcher(`${base}app.html`).catch(() => undefined);
      if (!page?.ok) continue;
      for (const href of pluginLinks(await page.text(), base, ["agent"])) {
        if (read.has(href) || !isAgentFile(href)) continue;
        const answer = await fetcher(href).catch(() => undefined);
        if (!answer?.ok) continue;
        read.add(href);
        const file = await answer.text();
        // A file for agents outside the app opens the MCP door instead (std/outside/module.ts).
        if (isOutsideFile(file)) continue;
        try {
          const source = fromAgentFile(file, IDLE);
          const config = made.get(source)!;
          if (runnerName(file)) unfit.set(config.id, `${config.name} runs a loop of its own (\`runner:\` in its file), which an editor can't follow step by step. Only agents on the standard loop can be talked to from an editor.`);
          else if (!config.inbox) unfit.set(config.id, `${config.name} doesn't take messages. An agent an editor can talk to has \`- message: true\` under \`on\` in its file.`);
          else if (!agents.has(config.id)) agents.set(config.id, { config, source, href, app });
        } catch (error) {
          record({ kind: "error", name: "acp:agent-file", detail: `${href}: ${says(error)}` });
        }
      }
    }
  }

  /** The agent an address names, started here if it wasn't. Throws what the person can do when it isn't one. */
  async function agentOf(id: string): Promise<Agent> {
    if (!kernel.lent()?.server) throw new Refusal("This site's spaces don't run plugins or agents on the server, so there is no agent here for an editor to talk to.");
    if (!agents.has(id) && Date.now() - looked > 3000) {
      looked = Date.now();
      await look();
    }
    const agent = agents.get(id);
    if (!agent) {
      if (unfit.has(id)) throw new Refusal(unfit.get(id)!);
      const names = [...agents.keys()];
      throw new Refusal(
        `No agent called ${id} is in this space. Open the app that links it in the space once (in a browser, at ${where.origin}/s/<space>/<app>/app.html), so the space knows the app. ${names.length ? `The agents here: ${names.join(", ")}.` : "No app opened in this space links an agent that takes messages yet."}`,
      );
    }
    const running = remote.installed.get(id);
    if (running && running.source !== agent.source) throw new Refusal(`This space already runs a plugin called ${id}, which isn't this agent. One of the two needs another id.`);
    if (!running) {
      const result = await remote.install(agent.source, { origin: "server", href: agent.href });
      if (!result.ok) throw new Refusal(`${agent.config.name} couldn't start on the space's server: ${result.error}`);
      record({ kind: "lifecycle", name: "acp:agent", plugin: id, detail: agent.href });
    }
    return agent;
  }

  // ---- The model: the space's own, for the turn's member ----

  const offProviders = root.on("llm:providers", function (this: { trace?: string } | null, state: { providers: unknown[] }, next: () => unknown) {
    if (this?.trace && turns.has(this.trace)) state.providers.push({ id: PROVIDER, name: "The space's model", ready: true });
    return next();
  });
  const offComplete = root.on("llm:complete", async function (this: { trace?: string } | null, request: Record<string, unknown>) {
    const turn = this?.trace ? turns.get(this.trace) : undefined;
    if (!turn || request?.provider !== PROVIDER) return undefined;
    const { provider: _provider, ...rest } = request;
    const answer = await model(turn.from, { op: "complete", request: rest });
    if (answer.status !== 200) return { error: String((answer.json as { error?: unknown })?.error ?? "The space's model gave no answer") };
    return (answer.json as { answer: unknown }).answer;
  });

  /** Asks the space's model door (std/spaces/model-key.ts), as the host would for this member. */
  async function model(from: From, form: Record<string, unknown>): Promise<RouteResponse> {
    const ask = kernel.lent()?.model;
    if (!ask) return { status: 501, json: { error: "This site's spaces can't hold a model key" } };
    return ask({ method: "POST", path: "/model", door: "model", member: from.member, form: { ...form, name: from.name, lock: from.lock ?? "", ...(from.gateways ? { gateways: from.gateways } : {}) } });
  }

  // ---- Conversations ----

  const fileOf = (id: string) => `${SESSIONS}/${id}.json`;

  async function sessionOf(id: unknown, agent: string, member: string): Promise<Session> {
    const gone = new Refusal("That conversation isn't here: it was started with another agent or by someone else, or it is more than a month old. Start a new one.", -32002);
    if (typeof id !== "string" || !SESSION_ID.test(id)) throw gone;
    let session = sessions.get(id);
    if (!session) {
      const kept = await store.readJson<{ agent?: string; member?: string; messages?: Message[] } | null>(fileOf(id), null);
      if (!kept || !Array.isArray(kept.messages)) throw gone;
      session = { id, agent: String(kept.agent), member: String(kept.member), messages: kept.messages };
      sessions.set(id, session);
    }
    if (session.agent !== agent || session.member !== member) throw gone;
    return session;
  }

  const keep = (session: Session) =>
    store.writeJson(fileOf(session.id), { agent: session.agent, member: session.member, at: new Date().toISOString(), messages: session.messages }).catch((error) => record({ kind: "error", name: "acp:session", detail: says(error) }));

  /**
   * Lets go of conversations not used for SESSION_DAYS, and of the least recently used past MAX_SESSIONS. A session's
   * id starts with when it was made, so only those made long enough ago, or past the count, are opened to see when
   * they were last used (`at`, which every turn writes). One with a turn under way is never let go.
   */
  async function prune() {
    const names = (await store.listFiles(SESSIONS).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
    const cutoff = Date.now() - SESSION_DAYS * 86_400_000;
    const busy = (name: string) => !!sessions.get(name.slice(0, -5))?.turn;
    const usedAt = async (name: string) => Date.parse((await store.readJson<{ at?: string } | null>(`${SESSIONS}/${name}`, null).catch(() => null))?.at ?? "") || 0;
    const remove = async (name: string) => {
      sessions.delete(name.slice(0, -5));
      await store.removeFile(`${SESSIONS}/${name}`).catch(() => {});
    };
    let left = names.length;
    for (const name of names) {
      if (parseInt(name.split("-")[0], 36) >= cutoff) break;
      if (!busy(name) && (await usedAt(name)) < cutoff) {
        await remove(name);
        left--;
      }
    }
    if (left <= MAX_SESSIONS) return;
    const rest = (await store.listFiles(SESSIONS).catch(() => [] as string[])).filter((n) => n.endsWith(".json") && !busy(n));
    const byUse = (await Promise.all(rest.map(async (name) => ({ name, at: await usedAt(name) })))).sort((a, b) => a.at - b.at);
    for (const { name } of byUse.slice(0, left - MAX_SESSIONS)) await remove(name);
  }

  /** Drops the oldest turns once a conversation is longer than the model is sent. */
  function trim(messages: Message[]) {
    const size = () => messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
    while (size() > MAX_HISTORY) {
      const next = messages.findIndex((m, i) => i > 0 && m.role === "user");
      if (next === -1) break;
      messages.splice(0, next);
    }
  }

  // ---- A turn ----

  /** Tells the editor of each review the agent is waiting on, until `done`. */
  function watchReviews(turn: Turn, agent: Agent, tools: () => Map<string, Tool>) {
    const timer = setInterval(() => {
      for (const [id, review] of reviews.waiting()) {
        if (review.instance !== agent.config.id || turn.told.has(id)) continue;
        turn.told.add(id);
        tell(turn, agent, id, review);
      }
    }, REVIEW_LOOK_MS);
    return () => clearInterval(timer);
  }

  function tell(turn: Turn, agent: Agent, id: string, review: Review) {
    // A review with no tool call under way is the agent asking to act for the person: it gets a line of its own.
    let toolCallId = turn.tool;
    if (!toolCallId) {
      toolCallId = `review-${id}`;
      update(turn, { sessionUpdate: "tool_call", toolCallId, title: `${agent.config.name} asks: ${review.target}`, kind: "other", status: "pending" });
    }
    const what = [review.reason && `Why: ${review.reason}`, review.before && `Before:\n${review.before}`, review.after && `After:\n${review.after}`].filter(Boolean).join("\n\n").slice(0, ANSWER);
    if (!turn.from.answers) {
      // This key can't answer for the person: the card waits on their devices, and the editor says so.
      update(turn, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "pending",
        title: `Waiting for your answer in the app: ${review.target}`,
        content: [{ type: "content", content: text(`This is waiting for you to accept or decline it in the app. Open ${where.origin}/s/<this space>/${agent.app}/app.html on one of your devices and answer the card there.\n\nTo answer in this editor instead, make a key for it on ${where.origin}/account/ (Agent keys, "An editor"), and use that key here.\n\n${what}`) }],
      });
      return;
    }
    const request = `review-${random().slice(0, 12)}`;
    turn.connection.asked.set(request, { review: id, turn });
    say(turn.connection, {
      jsonrpc: "2.0",
      id: request,
      method: "session/request_permission",
      params: {
        sessionId: turn.session.id,
        toolCall: { toolCallId, title: review.target, status: "pending", content: what ? [{ type: "content", content: text(what) }] : [] },
        options: [
          { optionId: "allow-once", name: "Accept", kind: "allow_once" },
          ...(review.once ? [] : [{ optionId: "allow-always", name: `Always allow ${review.name} in ${placeLabel(review.place)}`, kind: "allow_always" }]),
          { optionId: "reject", name: "Decline", kind: "reject_once" },
        ],
      },
    });
  }

  /** The editor's answer to a review it was asked. */
  function answered(connection: Connection, rpc: Rpc, from: From) {
    const asked = typeof rpc.id === "string" ? connection.asked.get(rpc.id) : undefined;
    if (!asked) return;
    connection.asked.delete(rpc.id as string);
    // Only a key made for the editor answers, whatever a client sends.
    if (!from.answers) return;
    const outcome = isObject(rpc.result) && isObject(rpc.result.outcome) ? rpc.result.outcome : {};
    const picked = outcome.outcome === "selected" ? outcome.optionId : undefined;
    const as = picked === "allow-once" ? "allowed-once" : picked === "allow-always" ? "allowed-always" : picked === "reject" ? "rejected" : undefined;
    // Anything else (cancelled, or an option this never offered) leaves the card where it is, on the members' devices.
    if (!as) return;
    record({ kind: "note", name: "review:answered", detail: `${as}, by ${from.member}, in their editor` });
    reviews.answer(asked.review, as, `review-by-${from.member}`);
  }

  /** One turn: the agent loop, each step told to the editor. Resolves to the stop reason. */
  async function run(turn: Turn, agent: Agent, prompt: string): Promise<string> {
    const { session } = turn;
    const instance = agent.config.id;
    const caps = remote.installed.get(instance)!.caps;
    const trace = `acp-${random().slice(0, 8)}`;
    const dispatch = { trace };
    const as = (service: string, method: string, args: unknown[]) => callService(remote.services, instance, caps, service, method, args, dispatch) as Promise<any>;
    // The conversation as it was: put back whole if the turn doesn't end by itself (trimming may have moved everything).
    const kept = [...session.messages];
    let byName = new Map<string, Tool>();
    turns.set(trace, turn);
    // From here a review the agent waits on is this turn's (one turn at a time for an agent): cancelling withdraws it.
    turn.running = instance;
    const deadline = setTimeout(() => {
      update(turn, { sessionUpdate: "agent_message_chunk", content: text(`${agent.config.name} was stopped: this turn took more than ${Math.round(TURN_MS / 60_000)} minutes. Nothing it was still waiting to change was changed. Ask again, in smaller steps.`) });
      turn.cancel();
    }, TURN_MS);
    const unwatch = watchReviews(turn, agent, () => byName);
    let runId: string | undefined;
    let steps = 0;
    let last = "";
    let reason = "end_turn";
    let ended = "completed";
    try {
      // The space has a key, and it works: said before anything is asked, in words for the person.
      const state = (await model(turn.from, { op: "state" })).json as { set?: boolean; refused?: boolean; byName?: string } | undefined;
      if (!state?.set) throw new Refusal(`This space has no model key, so ${agent.config.name} can't answer here. The space's owner can give it one on ${where.origin}/account/ (under the space, "A model for this space").`);
      if (state.refused) throw new Refusal(`The model key ${state.byName ?? "the owner"} gave this space was refused by its vendor, so ${agent.config.name} can't answer. They can give a new one on ${where.origin}/account/.`);

      const begun = await Promise.race([as("agents", "begin", [{ kind: "message", name: "your editor" }]), turn.stop]);
      if (begun === "cancelled") return "cancelled";
      if (!begun.ok) {
        const { limits } = agent.config;
        update(turn, { sessionUpdate: "agent_message_chunk", content: text(`${agent.config.name} has reached its limit (${limits.runsPerHour} runs an hour, ${limits.tokensPerDay.toLocaleString("en")} tokens a day, set in its file). Try again later.`) });
        return "refusal";
      }
      runId = begun.run as string;
      const own = (await as("tools", "list", [])) as Tool[];
      byName = new Map(own.map((t) => [t.name, t]));
      const tools = own.slice(0, 64).map(({ name, description, parameters }) => ({ name, description, parameters }));
      session.messages.push({ role: "user", content: prompt });
      trim(session.messages);

      for (;;) {
        if (turn.cancelled) return "cancelled";
        if (steps++ >= agent.config.limits.steps) {
          ended = "steps";
          reason = "max_turn_requests";
          break;
        }
        const answer = await Promise.race([as("agents", "complete", [runId, { system: agent.config.instructions, messages: session.messages, tools, model: agent.config.model, provider: PROVIDER }]), turn.stop]);
        if (answer === "cancelled") return "cancelled";
        if (!answer.ok) {
          update(turn, { sessionUpdate: "agent_message_chunk", content: text(`${agent.config.name} has used its tokens for today (${agent.config.limits.tokensPerDay.toLocaleString("en")}, set in its file). Try again tomorrow.`) });
          ended = "budget";
          reason = "refusal";
          break;
        }
        session.messages.push(answer.message as Message);
        last = typeof answer.text === "string" ? answer.text : "";
        if (last) update(turn, { sessionUpdate: "agent_message_chunk", messageId: `${trace}-${steps}`, content: text(last) });
        const calls = (answer.toolCalls ?? []) as { id: string; name: string; args?: Record<string, unknown> }[];
        if (!calls.length) {
          reason = answer.stop === "length" ? "max_tokens" : answer.stop === "refused" ? "refusal" : "end_turn";
          break;
        }
        for (const call of calls) {
          const tool = byName.get(call.name);
          // Told even once cancelled, as failed: every tool call the model asked for gets its answer in the conversation.
          // A vendor that gives its calls no ids numbers them afresh in each answer (call-1, call-2), so the step is in the id.
          const toolCallId = `${trace}-${steps}-${call.id}`;
          update(turn, { sessionUpdate: "tool_call", toolCallId, title: titleOf(tool, call.name), kind: kindOf(tool), status: "pending", rawInput: call.args ?? {} });
          let result: { ok: boolean; value?: unknown; error?: string };
          if (turn.cancelled) result = { ok: false, error: "Cancelled" };
          else {
            turn.tool = toolCallId;
            // Cancelling withdraws the review the tool may be waiting on (turn.cancel), so the tool answers; the turn
            // doesn't wait for a tool that takes its time after that.
            const calling = as("agents", "tool", [runId, call.name, call.args ?? {}]).catch((error) => ({ ok: false, error: says(error) }));
            result = (await Promise.race([calling, turn.stop.then(() => ({ ok: false, error: "Cancelled" }))])) as typeof result;
            turn.tool = undefined;
          }
          const content = (result.ok ? JSON.stringify(result.value ?? null) : `Error: ${result.error}`).slice(0, ANSWER);
          session.messages.push({ role: "tool", id: call.id, name: call.name, content });
          update(turn, { sessionUpdate: "tool_call_update", toolCallId, status: result.ok ? "completed" : "failed", content: [{ type: "content", content: text(content) }], rawOutput: result.ok ? (result.value ?? null) : { error: result.error } });
        }
      }
      return reason;
    } catch (error) {
      ended = "error";
      last = says(error);
      throw error;
    } finally {
      unwatch();
      clearTimeout(deadline);
      turn.running = undefined;
      turns.delete(trace);
      // A turn that didn't end by itself leaves nothing half said: the conversation is as it was before it.
      if (turn.cancelled || ended === "error") session.messages.splice(0, session.messages.length, ...kept);
      if (runId) await as("agents", "end", [runId, { stopReason: turn.cancelled ? "error" : ended, text: turn.cancelled ? "Cancelled from the editor" : last, steps: Math.min(steps, agent.config.limits.steps) }]).catch(() => {});
      // Whatever it still waited on is the turn's alone (one turn at a time for an agent): it goes with it.
      if (turn.cancelled) reviews.cancelInstance(instance);
      for (const [id, asked] of turn.connection.asked) if (asked.turn === turn) turn.connection.asked.delete(id);
      await keep(session);
    }
  }

  /** Starts a turn for a prompt, after any turn the agent has under way. Resolves once it is over and its answer is queued. */
  function prompted(connection: Connection, session: Session, agent: Agent, rpc: Rpc, from: From): Promise<void> {
    const reply = (body: Record<string, unknown>) => say(connection, { jsonrpc: "2.0", id: rpc.id, ...body });
    if (session.turn) {
      reply({ error: { code: -32600, message: "This conversation is still answering the last message. Wait for it, or cancel it, then send the next." } });
      return Promise.resolve();
    }
    let prompt: string;
    try {
      prompt = promptText(rpc.params?.prompt);
    } catch (error) {
      reply({ error: { code: error instanceof Refusal ? error.code : -32602, message: says(error) } });
      return Promise.resolve();
    }
    let cancel!: () => void;
    const stop = new Promise<"cancelled">((done) => (cancel = () => done("cancelled")));
    const turn: Turn = {
      session,
      connection,
      cancelled: false,
      stop,
      cancel: () => {
        if (turn.cancelled) return;
        turn.cancelled = true;
        // A card it left waiting is withdrawn now, not when its tool gives up: accepted after this, it would still write.
        if (turn.running) reviews.cancelInstance(turn.running);
        cancel();
      },
      told: new Set(),
      from,
    };
    session.turn = turn;
    const before = lines.get(agent.config.id) ?? Promise.resolve();
    // The agent's line: this turn runs after the one before it, and the next after this, cancelled or not.
    const ran = before.then(() => (turn.cancelled ? "cancelled" : run(turn, agent, prompt)));
    const line = ran.then(
      () => {},
      () => {},
    );
    lines.set(agent.config.id, line);
    void line.finally(() => {
      if (lines.get(agent.config.id) === line) lines.delete(agent.config.id);
    });
    // A turn cancelled while it waited its place is answered then, not when the turn ahead of it ends.
    const waited = Promise.race([before.then(() => "go" as const), stop]).then((first) => (first === "cancelled" && !turn.running ? "cancelled" : ran));
    return waited
      .then(
        (stopReason) => reply({ result: { stopReason: turn.cancelled ? "cancelled" : stopReason } }),
        (error) => (turn.cancelled ? reply({ result: { stopReason: "cancelled" } }) : reply({ error: { code: error instanceof Refusal ? error.code : -32603, message: says(error) } })),
      )
      .finally(() => {
        if (session.turn === turn) session.turn = undefined;
      });
  }

  /** What was said in a conversation, for an editor that takes it up again. */
  function replay(connection: Connection, session: Session) {
    const out = (body: Record<string, unknown>) => say(connection, { jsonrpc: "2.0", method: "session/update", params: { sessionId: session.id, update: body } });
    // A model's own ids for its calls can repeat in a conversation (std/llm/gemini.js numbers them afresh in each
    // answer), so each call is told by where it is, and a tool's answer goes to the latest call with its id.
    const latest = new Map<string, string>();
    session.messages.forEach((m, at) => {
      if (m.role === "user" && typeof m.content === "string") out({ sessionUpdate: "user_message_chunk", content: text(m.content) });
      else if (m.role === "assistant") {
        if (typeof m.content === "string" && m.content) out({ sessionUpdate: "agent_message_chunk", content: text(m.content) });
        for (const call of (Array.isArray(m.toolCalls) ? m.toolCalls : []) as { id: string; name: string; args?: unknown }[]) {
          const toolCallId = `${session.id}-${at}-${call.id}`;
          latest.set(call.id, toolCallId);
          out({ sessionUpdate: "tool_call", toolCallId, title: call.name, kind: "other", status: "pending", rawInput: call.args ?? {} });
        }
      } else if (m.role === "tool") out({ sessionUpdate: "tool_call_update", toolCallId: latest.get(String(m.id)) ?? `${session.id}-${at}-${String(m.id)}`, status: String(m.content).startsWith("Error: ") ? "failed" : "completed", content: [{ type: "content", content: text(String(m.content)) }] });
    });
  }

  // ---- The door ----

  const json = (status: number, body: Record<string, unknown>): RouteResponse => ({ status, json: body });
  const failed = (status: number, code: number, message: string, id: unknown = null) => json(status, { reply: { jsonrpc: "2.0", id, error: { code, message } } });

  async function knock(request: RouteRequest): Promise<RouteResponse | null> {
    if (stopped) return null;
    const agentId = request.path.split("/")[2] ?? "";
    const member = request.member ?? "";
    if (!member) return failed(403, -32000, "Only the space's server can ask this");
    const given = request.query?.connection || undefined;

    if (request.method === "DELETE") {
      const connection = given ? connections.get(given) : undefined;
      if (connection && connection.agent === agentId && connection.member === member) {
        for (const session of sessions.values()) if (session.turn?.connection === connection) session.turn.cancel();
        connections.delete(given!);
        // Its stream, if one is open, hears that it's over.
        where.changed?.("acp");
      }
      return { status: 202 };
    }

    // The host asks, for the editor's stream, what there is to send after the last it sent.
    if (request.method === "GET") {
      const connection = connectionOf(given, agentId, member);
      const stream = request.query?.stream;
      if (!connection || !stream) return failed(404, -32000, "That connection isn't yours, or has ended: connect again (initialize)");
      if (request.query?.first === "1") {
        // An older stream for the connection hears that this one took over.
        if (connection.stream && connection.stream !== stream) where.changed?.("acp");
        connection.stream = stream;
      } else if (!connection.stream) connection.stream = stream;
      else if (connection.stream !== stream) return failed(409, -32000, "A newer stream for this connection took over");
      const after = Number(request.query?.after) || 0;
      // Only what the editor itself said it has (the Last-Event-ID a stream opens with) is let go. What the host has
      // sent since may still be on its way: if that stream drops, the next one asks for it again.
      if (request.query?.first === "1") {
        connection.queue = connection.queue.filter((m) => m.seq > after);
        connection.size = connection.queue.reduce((n, m) => n + m.size, 0);
      }
      return json(200, { notices: connection.queue.filter((m) => m.seq > after).map(({ seq, message }) => ({ seq, message })) });
    }

    const form = (request.form ?? {}) as { message?: unknown; name?: unknown; answers?: unknown; lock?: unknown; gateways?: unknown };
    const rpc = form.message as Rpc;
    if (Array.isArray(rpc)) return failed(400, -32600, "One message at a time: ACP has no batches");
    if (!isObject(rpc) || rpc.jsonrpc !== "2.0") return failed(400, -32600, "Not a JSON-RPC 2.0 message");
    const from: From = {
      member,
      name: typeof form.name === "string" && form.name ? form.name : "A member",
      answers: form.answers === true,
      ...(typeof form.lock === "string" ? { lock: form.lock } : {}),
      ...(isObject(form.gateways) ? { gateways: form.gateways as Record<string, string> } : {}),
    };

    // The first message: it makes the connection, and is the one request answered then and there.
    if (rpc.method === "initialize") {
      if (rpc.id === undefined || rpc.id === null) return failed(400, -32600, "initialize is a request: give it an id");
      let agent: Agent;
      try {
        agent = await agentOf(agentId);
      } catch (error) {
        return failed(200, error instanceof Refusal ? error.code : -32603, says(error), rpc.id);
      }
      const id = random();
      admit(id, agentId, member);
      return json(200, {
        connection: id,
        reply: {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: ACP_VERSION,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true }, mcpCapabilities: { http: false, sse: false } },
            agentInfo: { name: agent.config.id, title: agent.config.name, version: remote.installed.get(agentId)?.manifest.version ?? "1.0.0" },
            authMethods: [],
          },
        },
      });
    }

    const connection = connectionOf(given, agentId, member);
    if (!connection) return failed(given ? 404 : 400, -32000, given ? "That connection isn't yours, or has ended: connect again (initialize)" : "Connect first (initialize), then send the Acp-Connection-Id you were given");

    // The editor's answer to something asked of it: a review.
    if (typeof rpc.method !== "string") {
      answered(connection, rpc, from);
      return { status: 202 };
    }

    // A notification: heard, never answered.
    if (rpc.id === undefined || rpc.id === null) {
      if (rpc.method === "session/cancel") {
        const session = sessions.get(String(rpc.params?.sessionId ?? ""));
        if (session && session.member === member && session.agent === agentId) session.turn?.cancel();
      }
      return { status: 202 };
    }

    const reply = (body: Record<string, unknown>) => say(connection, { jsonrpc: "2.0", id: rpc.id, ...body });
    try {
      const agent = await agentOf(agentId);
      switch (rpc.method) {
        case "authenticate":
          reply({ result: {} });
          break;
        case "session/new": {
          const id = `${Date.now().toString(36)}-${random()}`;
          const session: Session = { id, agent: agentId, member, messages: [] };
          sessions.set(id, session);
          await keep(session);
          void prune();
          reply({ result: { sessionId: id } });
          break;
        }
        case "session/load": {
          const session = await sessionOf(rpc.params?.sessionId, agentId, member);
          replay(connection, session);
          reply({ result: {} });
          break;
        }
        case "session/prompt": {
          const session = await sessionOf(rpc.params?.sessionId, agentId, member);
          // Held until the turn is over, so the space's server stays up for it. The answer itself goes on the stream, after the turn's last update.
          await prompted(connection, session, agent, rpc, from);
          break;
        }
        default:
          reply({ error: { code: -32601, message: `This agent has no method ${rpc.method}` } });
      }
    } catch (error) {
      reply({ error: { code: error instanceof Refusal ? error.code : -32603, message: says(error) } });
    }
    return { status: 202 };
  }

  return {
    knock,
    stop() {
      stopped = true;
      offProviders?.();
      offComplete?.();
      for (const session of sessions.values()) session.turn?.cancel();
      connections.clear();
      sessions.clear();
    },
  };
}

export type AcpDoor = ReturnType<typeof acpDoor>;
