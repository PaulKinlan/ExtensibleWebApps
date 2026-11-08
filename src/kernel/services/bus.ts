// The `bus` service: how agents and plugins talk to each other and to the
// person, by message rather than by calling each other.
//
//   Inboxes      An agent whose file says `on: - message: true`, or a plugin
//                with the `bus:inbox` permission, has an inbox. Anyone with
//                `bus:send:<id>` may put a message in it:
//
//                  await ctx.call("bus", "send", "bibliographer", "Who wrote Piranesi?", { reply: true });
//                  // → { stopReason: "completed", text: "Susanna Clarke, 2020" }
//
//                With reply, the call waits for the answer: an agent's answer
//                is what it says at the end of the run the message woke.
//   Topics       `bus.post(topic, text)` with `bus:post:<topic>`; agents whose
//                file says `on: - topic: <topic>` wake on each post, and
//                `bus.read(topic)` with `bus:read:<topic>` lists the recent ones.
//   The person   `bus.ask(question, choices?)` with `bus:ask` puts a question
//                on the board (std/board.js) and waits for the person's answer.
//
// A message is information the sender wrote: it never lets the recipient do
// anything its own permissions don't. The events say only who and where, and
// the recipient fetches what was sent (bus.receive), so a plugin that
// listens learns nothing it couldn't read anyway.
//
// Found by name: this file is src/kernel/services/bus.ts, so it is `ctx.call("bus", …)`.

import { grants } from "../gate";
import { defineHook } from "../hooks";
import type { ServiceProvider } from "../remote";
import type { Kernel } from "./index";

const base = (instance: string) => instance.split("@")[0];
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const TEXT = 10_000;
const DATA = 100_000;
/** Messages waiting in one inbox, and posts kept for one topic. */
const WAITING = 50;
const POSTS = 50;
/** How long a sender waits for a reply, and an agent for the person's answer. */
const REPLY_MS = 30 * 60_000;
const ASK_MS = 24 * 60 * 60_000;
/** How long a chain of messages may grow: A asks B, who asks C, who asks D. */
const DEPTH = 4;
const NAME = /^[a-z][a-z0-9-]{0,63}$/;

type Message = { id: string; from: string; to: string; text: string; data?: unknown; reply: boolean; chain: string[]; at: number };
type Post = { id: string; topic: string; from: string; text: string; at: number };
type Answer = { stopReason: string; text: string; value?: unknown };
type Question = { id: string; from: string; question: string; choices?: string[]; at: number; answer: (value: string | null) => void };

export default ({ root, remote, store, apps }: Kernel): ServiceProvider => {
  defineHook("bus:message", { mode: "emit", needs: "bus:inbox", args: "{ to }", description: "A message is waiting in to's inbox. Only plugins with an inbox hear it; the one named fetches it with bus.receive." });
  defineHook("bus:posted", { mode: "emit", args: "{ topic, id, from }", description: "Someone posted to a topic. Read it with bus.read, which needs bus:read:<topic>." });
  defineHook("bus:asked", { mode: "emit", args: "{ id, from }", description: "An agent or plugin asked the person a question (bus.ask). The board lists it with bus.questions." });
  defineHook("bus:answered", { mode: "emit", args: "{ id, from, answered }", description: "A question was answered, or gave up waiting (answered is false)." });

  const FILE = "bus/state.json";
  type State = { inboxes: Record<string, Message[]>; topics: Record<string, Post[]> };
  const fresh = (): State => ({ inboxes: Object.create(null), topics: Object.create(null) });
  /** Waiting messages and recent posts, kept with the app's data so they survive a reload. */
  const state = store.readJson<unknown>(FILE, {}).then((s) => {
    const out = fresh();
    if (isObject(s)) {
      if (isObject(s.inboxes)) Object.assign(out.inboxes, s.inboxes);
      if (isObject(s.topics)) Object.assign(out.topics, s.topics);
    }
    return out;
  });
  const save = async () => store.writeJson(FILE, await state).catch(() => {});
  let next = 0;
  const newId = (kind: string) => `${kind}-${Date.now().toString(36)}-${++next}`;

  /** Senders waiting for a reply, by message id. */
  const waiting = new Map<string, { resolve: (answer: Answer) => void; message: Message }>();
  /** Questions waiting for the person. */
  const questions = new Map<string, Question>();

  const hasInbox = (id: string) => {
    const plugin = remote.installed.get(id);
    return !!plugin?.enabled && grants(plugin.caps, "bus:inbox");
  };
  /** What a sender is answering now: the chains of the messages it took and hasn't answered. */
  const chainOf = (id: string) => {
    const out = new Set<string>();
    for (const { message } of waiting.values()) if (message.to === id && taken.has(message.id)) for (const c of message.chain) out.add(c);
    return out;
  };
  /** Messages a recipient has taken from its inbox and not yet answered. */
  const taken = new Set<string>();

  function textOf(message: unknown): { text: string; data?: unknown } {
    if (typeof message === "string") return { text: message.slice(0, TEXT) };
    if (isObject(message) && typeof message.text === "string") {
      const out: { text: string; data?: unknown } = { text: message.text.slice(0, TEXT) };
      if (message.data !== undefined) {
        const json = JSON.stringify(message.data);
        if (json === undefined || json.length > DATA) throw new Error("A message's data is JSON, up to 100 KB");
        out.data = JSON.parse(json);
      }
      return out;
    }
    throw new Error("A message is text, or { text, data? }");
  }

  return {
    description: "Messages between agents, plugins and the person: inboxes with replies, topics, and questions on the board. A message is information, never permission.",
    methods: {
      send: {
        args: "(to, message, { reply? }?)",
        returns: "{ ok: true, id }, or with reply, the answer: { stopReason, text, value? }",
        needs: "bus:send:<to>",
        description: "Puts a message (text, or { text, data }) in an agent's or plugin's inbox. With reply: true it waits, up to 30 minutes, for the answer; an agent answers with what it says at the end of the run the message woke. A chain of messages may be four long, and never come back to an agent already in it.",
        params: [
          { name: "to", schema: { type: "string", description: "Whose inbox" }, names: "bus:send:" },
          { name: "message", schema: { type: "string", description: "What to say" } },
          { name: "options", schema: { type: "object", properties: { reply: { type: "boolean", description: "Wait for the answer" } } }, optional: true },
        ],
      },
      receive: { args: "()", returns: "[{ id, from, text, data?, reply }]", needs: "bus:inbox", description: "Takes the messages waiting in the caller's inbox, oldest first. Answer each one that wants a reply with bus.reply." },
      reply: { args: "(id, { stopReason?, text, value? })", returns: "true", needs: "bus:inbox", description: "Answers a message the caller received. stopReason is completed (the default), blocked, error, budget or cancelled." },
      post: {
        args: "(topic, message)",
        returns: "{ ok: true, id }",
        needs: "bus:post:<topic>",
        description: "Posts to a topic. Agents that wake on the topic run, and readers hear bus:posted.",
        params: [
          { name: "topic", schema: { type: "string" }, names: "bus:post:" },
          { name: "message", schema: { type: "string", description: "What to post" } },
        ],
      },
      read: {
        args: "(topic, since?)",
        returns: "[{ id, from, text, at }]",
        needs: "bus:read:<topic>",
        description: "The topic's recent posts (the last 50), oldest first, or only those after the post `since`.",
        params: [
          { name: "topic", schema: { type: "string" }, names: "bus:read:" },
          { name: "since", schema: { type: "string", description: "A post's id: only posts after it" }, optional: true },
        ],
      },
      ask: {
        args: "(question, choices?)",
        returns: "{ answered: true, answer } or { answered: false }",
        needs: "bus:ask",
        description: "Asks the person a question on the board and waits for the answer, up to a day. With choices, the person picks one; otherwise they write an answer.",
        params: [
          { name: "question", schema: { type: "string", description: "The question, in one or two sentences" } },
          { name: "choices", schema: { type: "array", items: { type: "string" }, description: "Up to six answers to pick from" }, optional: true },
        ],
      },
      questions: { args: "()", returns: "[{ id, from, name, question, choices?, at }]", needs: "bus:board", description: "The questions waiting for the person from the caller's app (from anyone, for a plugin no app links)." },
      answer: { args: "(id, answer)", returns: "true", needs: "bus:board", description: "Gives the person's answer to a question. Only a board should call it, with what the person chose or wrote." },
    },
    capability: (method, args) => {
      if (method === "send") return `bus:send:${String(args[0])}`;
      if (method === "post") return `bus:post:${String(args[0])}`;
      if (method === "read") return `bus:read:${String(args[0])}`;
      if (method === "receive" || method === "reply") return "bus:inbox";
      if (method === "ask") return "bus:ask";
      if (method === "questions" || method === "answer") return "bus:board";
      return undefined;
    },
    call: async (instance, method, args, dispatch) => {
      const me = base(instance);
      const s = await state;

      if (method === "send") {
        const [to, message, options] = args;
        if (typeof to !== "string" || !hasInbox(to)) throw new Error(`${String(to)} has no inbox`);
        const { text, data } = textOf(message);
        const reply = isObject(options) && options.reply === true;
        const chain = [...chainOf(me), me];
        if (chain.includes(to)) throw new Error(`${to} is already waiting in this chain of messages (${chain.join(" → ")}), so it can't answer`);
        if (chain.length > DEPTH) throw new Error(`A chain of messages may be ${DEPTH} long: ${chain.join(" → ")} → ${to}`);
        const box = (s.inboxes[to] ??= []);
        if (box.length >= WAITING) throw new Error(`${to}'s inbox is full`);
        const m: Message = { id: newId("m"), from: me, to, text, ...(data !== undefined ? { data } : {}), reply, chain, at: Date.now() };
        box.push(m);
        void save();
        const answered = reply
          ? new Promise<Answer>((resolve) => {
              const timer = setTimeout(() => {
                waiting.delete(m.id);
                taken.delete(m.id);
                resolve({ stopReason: "cancelled", text: `${to} didn't answer in time` });
              }, REPLY_MS);
              waiting.set(m.id, { resolve: (a) => (clearTimeout(timer), resolve(a)), message: m });
            })
          : undefined;
        root.emit(dispatch, "bus:message", { to });
        return answered ? await answered : { ok: true, id: m.id };
      }

      if (method === "receive") {
        const box = s.inboxes[me] ?? [];
        delete s.inboxes[me];
        if (box.length) void save();
        // A reply nobody waits for any more (the sender's tab closed, or the kernel restarted) isn't asked for.
        for (const m of box) if (m.reply && waiting.has(m.id)) taken.add(m.id);
        return box.map((m) => ({ id: m.id, from: m.from, text: m.text, ...(m.data !== undefined ? { data: m.data } : {}), reply: m.reply && waiting.has(m.id) }));
      }

      if (method === "reply") {
        const [id, answer] = args;
        const w = typeof id === "string" ? waiting.get(id) : undefined;
        if (!w || w.message.to !== me) throw new Error("Not a message waiting for this plugin's reply");
        const a = isObject(answer) ? answer : { text: answer };
        const stopReason = ["completed", "blocked", "error", "budget", "cancelled"].includes(a.stopReason as string) ? (a.stopReason as string) : "completed";
        const out: Answer = { stopReason, text: String(a.text ?? "").slice(0, TEXT) };
        if (a.value !== undefined) out.value = textOf({ text: "", data: a.value }).data;
        waiting.delete(id as string);
        taken.delete(id as string);
        w.resolve(out);
        return true;
      }

      if (method === "post") {
        const [topic, message] = args;
        if (typeof topic !== "string" || !NAME.test(topic)) throw new Error("A topic is lowercase letters, digits and dashes");
        const { text } = textOf(message);
        const posts = (s.topics[topic] ??= []);
        const p: Post = { id: newId("p"), topic, from: me, text, at: Date.now() };
        posts.push(p);
        if (posts.length > POSTS) posts.splice(0, posts.length - POSTS);
        void save();
        root.emit(dispatch, "bus:posted", { topic, id: p.id, from: me });
        return { ok: true, id: p.id };
      }

      if (method === "read") {
        const [topic, since] = args;
        const posts = (typeof topic === "string" && s.topics[topic]) || [];
        const from = typeof since === "string" ? posts.findIndex((p) => p.id === since) + 1 : 0;
        return posts.slice(from).map(({ id, from, text, at }) => ({ id, from, text, at }));
      }

      if (method === "ask") {
        const [question, choices] = args;
        if (typeof question !== "string" || !question.trim()) throw new Error("A question is text");
        if (choices !== undefined && (!Array.isArray(choices) || choices.length > 6 || choices.some((c) => typeof c !== "string" || !c || c.length > 200))) throw new Error("choices are up to six short answers");
        const id = newId("q");
        const answer = await new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => done(null), ASK_MS);
          const done = (value: string | null) => {
            clearTimeout(timer);
            questions.delete(id);
            root.emit(dispatch, "bus:answered", { id, from: me, answered: value !== null });
            resolve(value);
          };
          questions.set(id, { id, from: me, question: question.slice(0, 2000), ...(choices ? { choices: choices as string[] } : {}), at: Date.now(), answer: done });
          root.emit(dispatch, "bus:asked", { id, from: me });
        });
        return answer === null ? { answered: false } : { answered: true, answer };
      }

      if (method === "questions") {
        const mine = apps.alongside(instance);
        return [...questions.values()]
          .filter((q) => !mine || mine.has(q.from))
          .map(({ id, from, question, choices, at }) => ({ id, from, name: remote.installed.get(from)?.manifest.name ?? from, question, ...(choices ? { choices } : {}), at }));
      }

      if (method === "answer") {
        const [id, answer] = args;
        const q = typeof id === "string" ? questions.get(id) : undefined;
        const mine = apps.alongside(instance);
        if (!q || (mine && !mine.has(q.from))) throw new Error("No question waiting with that id");
        if (typeof answer !== "string" || !answer.trim()) throw new Error("An answer is text");
        if (q.choices && !q.choices.includes(answer)) throw new Error(`The answer is one of: ${q.choices.join(", ")}`);
        q.answer(answer.slice(0, TEXT));
        return true;
      }

      throw new Error(`bus.${method} is not a method`);
    },
  };
};
