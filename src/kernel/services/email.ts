// The `email` service: mail a server plugin sends, with the `email` permission.
// Found by name: this file is src/kernel/services/email.ts, so it is `ctx.call("email", …)`.
//
//   await ctx.call("email", "send", { to: ["sam@example.com"], subject: "3 new answers", text: "…" });
//
// Only a space's server sends mail: a plugin in a browser would be sending as
// whoever has the tab open. Until the deployment sets up a way to deliver it
// (Cloudflare Email, SMTP), each message is written down in the space's folder
// as server/outbox/<time>-<id>.json, which no plugin can read.
//
// Mail goes only to the space's members: to the address each gave on their
// account page (/account/), which the host reads from the accounts
// (env().addresses). A plugin with a public route can't be made to mail
// anyone else, and a host that can't say who the members are sends nothing.
//
// A plugin sends at most MAX_PER_DAY messages a day, each to at most MAX_TO
// people, so a plugin with a public route can't be made into a way to send
// anyone mail without end. The count is kept in server/email.json.

import { env } from "../env";
import type { ServiceProvider } from "../remote";
import { record } from "../trace";
import type { Kernel } from "./index";

const OUTBOX = "server/outbox";
const COUNTS = "server/email.json";
const MAX_TO = 10;
const MAX_PER_DAY = 50;
const MAX_SUBJECT = 200;
const MAX_BODY = 100_000;
// A local part, then a domain of dot-separated labels with none empty. No spaces, controls or separators anywhere.
const ADDRESS = /^[^@\s\x00-\x1f\x7f<>,;"]+@[^@\s\x00-\x1f\x7f<>,;".]+(\.[^@\s\x00-\x1f\x7f<>,;".]+)+$/;

const base = (instance: string) => instance.split("@")[0];
const today = () => new Date().toISOString().slice(0, 10);

export interface Mail {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

/** An address with its domain in lowercase. The part before the @ is kept as written: it may be case-sensitive. */
const normal = (address: string) => {
  const at = address.lastIndexOf("@");
  return address.slice(0, at) + address.slice(at).toLowerCase();
};

/** The message as the plugin gave it, checked: or throws, saying what is wrong. */
export function checkMail(value: unknown): Mail {
  const m = (value ?? {}) as Record<string, unknown>;
  const to = typeof m.to === "string" ? [m.to] : m.to;
  if (!Array.isArray(to) || !to.length) throw new Error("A message needs `to`: an address, or a list of them");
  if (to.length > MAX_TO) throw new Error(`A message goes to at most ${MAX_TO} people`);
  for (const address of to) if (typeof address !== "string" || address.length > 254 || !ADDRESS.test(address)) throw new Error(`Not an email address: ${JSON.stringify(address)}`);
  if (typeof m.subject !== "string" || !m.subject.trim()) throw new Error("A message needs a `subject`");
  // A line break in a subject would start a header of its own.
  if (m.subject.length > MAX_SUBJECT || /[\r\n]/.test(m.subject)) throw new Error(`A subject is one line, at most ${MAX_SUBJECT} characters`);
  if (typeof m.text !== "string") throw new Error("A message needs `text`, its plain words");
  if (m.html !== undefined && typeof m.html !== "string") throw new Error("A message's `html` is a string");
  if (m.text.length + (m.html?.length ?? 0) > MAX_BODY) throw new Error("The message is too long");
  return { to: [...new Set(to.map(normal))], subject: m.subject, text: m.text, ...(m.html !== undefined && { html: m.html }) };
}

export default ({ store }: Kernel): ServiceProvider => {
  /** Sends one at a time, so two at once can't both take the last of a plugin's day. */
  let queue: Promise<unknown> = Promise.resolve();

  async function send(plugin: string, mail: Mail, trace?: string) {
    const saved = await store.readJson<{ day?: string; sent?: Record<string, number> }>(COUNTS, {});
    // No prototype, so a plugin named like one of Object's own properties (constructor) starts at zero too.
    const counts: Record<string, number> = Object.assign(Object.create(null), saved.day === today() ? saved.sent : {});
    if ((counts[plugin] ?? 0) >= MAX_PER_DAY) {
      record({ kind: "denied", name: "email:limit", plugin, trace, detail: `${MAX_PER_DAY} a day` });
      throw new Error(`A plugin sends at most ${MAX_PER_DAY} messages a day`);
    }
    counts[plugin] = (counts[plugin] ?? 0) + 1;
    await store.writeJson(COUNTS, { day: today(), sent: counts });
    const at = Date.now();
    const id = `${at}-${Math.random().toString(36).slice(2, 10)}`;
    await store.writeJson(`${OUTBOX}/${id}.json`, { id, from: plugin, at, ...mail });
    record({ kind: "lifecycle", name: "email:sent", plugin, trace, detail: `${mail.to.length} recipient${mail.to.length === 1 ? "" : "s"}: ${mail.subject}` });
    return { ok: true, id };
  }

  return {
    description: "Email: messages a plugin on a space's server sends to the space's members. Until the deployment delivers mail, each is written down in the space's outbox.",
    methods: {
      send: {
        args: "({ to, subject, text, html? })",
        returns: "{ ok, id }",
        needs: "email",
        description: `Sends a message to \`to\` (a member's address or a list of them, at most ${MAX_TO}: only addresses the space's members gave on their accounts), with a one-line \`subject\`, plain \`text\` and, if given, \`html\`. Only on a space's server; at most ${MAX_PER_DAY} a day for each plugin.`,
      },
    },
    capability: () => "email",
    call: async (instance, method, args, dispatch) => {
      if (method !== "send") throw new Error(`email has no method ${method}`);
      if (env().kind !== "server") throw new Error('Email is sent from a space\'s server: a plugin that sends it has runs: "server"');
      const mail = checkMail(args[0]);
      // Compared without case: the same person, whatever case they or a plugin typed it in.
      const members = new Set(((await env().addresses?.()) ?? []).map((a) => a.toLowerCase()));
      const outside = mail.to.filter((address) => !members.has(address.toLowerCase()));
      if (outside.length) {
        record({ kind: "denied", name: "email:not-a-member", plugin: base(instance), trace: dispatch?.trace, detail: `${outside.length} address${outside.length === 1 ? "" : "es"}` });
        throw new Error(`Email goes only to the space's members, at the address they gave on their account page: ${outside.join(", ")} isn't one`);
      }
      const run = queue.then(() => send(base(instance), mail, dispatch?.trace));
      queue = run.catch(() => {});
      return run;
    },
  };
};
