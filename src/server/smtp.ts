// Email from a Node server, over SMTP: the email module (std/email/module.ts)
// writes a message to the space's outbox, and the server hands it here to
// send. A deployment sets it up with two settings:
//
//   SMTP_URL    smtps://user:password@smtp.example.com:465 (TLS from the start), or
//               smtp://user:password@smtp.example.com:587 (STARTTLS, which is then required)
//   EMAIL_FROM  the address mail comes from, such as "Extensible Web Apps <apps@example.com>"
//
// Without both, mail stays in the outbox. smtp:// to this machine (localhost,
// 127.0.0.1) may skip STARTTLS, for a local mail catcher in development.
//
// A small client of its own (no dependencies): EHLO, STARTTLS, AUTH PLAIN or
// LOGIN, then one message, sent as UTF-8 text (and HTML, if given) in base64,
// so no line is too long and no dot needs escaping.

import { randomUUID } from "node:crypto";
import { connect as plain, type Socket } from "node:net";
import { connect as secure, type TLSSocket } from "node:tls";
import type { Email, Message } from "../seams/index.ts";

export interface SmtpOptions {
  url: string;
  from: string;
  /** For the checks only: trust this certificate, as a test mail server's is its own. */
  ca?: string;
  /** How long to wait for any answer, in ms. */
  timeout?: number;
}

/** The address inside "Name <address>", or the address itself. */
const bare = (from: string) => /<([^>]+)>\s*$/.exec(from)?.[1] ?? from.trim();
/** A header's words, encoded when they aren't plain ASCII (RFC 2047). */
const word = (text: string) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`);
const lines76 = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n");
const local = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";

/** The message as it goes over the wire, headers and body. */
export function mime(message: Message, from: string, id: string): string {
  const domain = bare(from).split("@")[1] ?? "localhost";
  const headers = [
    `From: ${from}`,
    `To: ${message.to.join(", ")}`,
    `Subject: ${word(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${id}@${domain}>`,
    "MIME-Version: 1.0",
  ];
  const part = (type: string, text: string) => [`Content-Type: ${type}; charset=utf-8`, "Content-Transfer-Encoding: base64", "", lines76(Buffer.from(text).toString("base64"))].join("\r\n");
  if (message.html === undefined) return `${headers.join("\r\n")}\r\n${part("text/plain", message.text)}`;
  const boundary = `=_${randomUUID()}`;
  return [...headers, `Content-Type: multipart/alternative; boundary="${boundary}"`, "", `--${boundary}`, part("text/plain", message.text), `--${boundary}`, part("text/html", message.html), `--${boundary}--`, ""].join("\r\n");
}

/** One SMTP conversation on a socket: what the server says, a reply at a time. `stop` lets go of the socket (for STARTTLS). */
function conversation(socket: Socket | TLSSocket, timeout: number) {
  let buffer = "";
  let waiting: { done: (reply: { code: number; text: string }) => void; fail: (error: Error) => void } | undefined;
  let failed: Error | undefined;
  const check = () => {
    // A reply is lines of "250-…" ending with one "250 …".
    const end = /(^|\r\n)(\d{3}) [^\r\n]*\r\n/.exec(buffer);
    if (!end || !waiting) return;
    const text = buffer.slice(0, end.index + end[0].length);
    buffer = buffer.slice(text.length);
    const w = waiting;
    waiting = undefined;
    w.done({ code: Number(end[2]), text });
  };
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    check();
  };
  const onError = (error: Error) => {
    failed = error;
    waiting?.fail(error);
  };
  const onClose = () => onError(new Error("The mail server closed the connection"));
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  return {
    reply: () =>
      new Promise<{ code: number; text: string }>((done, fail) => {
        if (failed) return fail(failed);
        const timer = setTimeout(() => fail(new Error("The mail server didn't answer in time")), timeout);
        waiting = { done: (r) => (clearTimeout(timer), done(r)), fail: (e) => (clearTimeout(timer), fail(e)) };
        check();
      }),
    stop() {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    },
  };
}

/** Sends email over SMTP. */
export function smtpMailer(options: SmtpOptions): Email {
  const url = new URL(options.url);
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") throw new Error("SMTP_URL is smtp:// or smtps://");
  const implicit = url.protocol === "smtps:";
  const host = url.hostname;
  const port = Number(url.port || (implicit ? 465 : 587));
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const timeout = options.timeout ?? 20_000;
  const tls = { servername: /^[\d.]+$|:/.test(host) ? undefined : host, ...(options.ca ? { ca: options.ca } : {}) };

  return {
    async send(message) {
      const id = randomUUID();
      let socket: Socket | TLSSocket = implicit ? secure({ host, port, ...tls }) : plain({ host, port });
      let talk = conversation(socket, timeout);
      const say = async (line: string, want: number[], what = line.split(" ")[0]) => {
        socket.write(`${line}\r\n`);
        const r = await talk.reply();
        if (!want.includes(r.code)) throw new Error(`The mail server refused ${what}: ${r.text.trim().split("\r\n").pop()}`);
        return r;
      };
      try {
        const hello = await talk.reply();
        if (hello.code !== 220) throw new Error(`The mail server said: ${hello.text.trim()}`);
        let ehlo = await say(`EHLO ${bare(options.from).split("@")[1] ?? "localhost"}`, [250]);
        if (!implicit) {
          if (/[- ]STARTTLS\b/i.test(ehlo.text)) {
            await say("STARTTLS", [220]);
            talk.stop();
            socket = secure({ socket, ...tls });
            talk = conversation(socket, timeout);
            await new Promise<void>((done, fail) => (socket as TLSSocket).once("secureConnect", done).once("error", fail));
            ehlo = await say(`EHLO ${bare(options.from).split("@")[1] ?? "localhost"}`, [250]);
          } else if (!local(host)) throw new Error("The mail server doesn't offer STARTTLS: use smtps://, or a server that does");
        }
        if (user) {
          if (/AUTH[ =][^\r\n]*\bPLAIN\b/i.test(ehlo.text)) await say(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString("base64")}`, [235], "the user name and password");
          else {
            await say("AUTH LOGIN", [334]);
            await say(Buffer.from(user).toString("base64"), [334], "the user name");
            await say(Buffer.from(pass).toString("base64"), [235], "the password");
          }
        }
        await say(`MAIL FROM:<${bare(options.from)}>`, [250]);
        for (const to of message.to) await say(`RCPT TO:<${to}>`, [250, 251], `${to}`);
        await say("DATA", [354]);
        // Every line of the body is base64 or a header, so none starts with a dot.
        await say(`${mime(message, options.from, id)}\r\n.`, [250], "the message");
        talk.stop();
        socket.write("QUIT\r\n");
        return { ok: true, id };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        // Anything the server says now is past caring about, errors included.
        socket.on("error", () => {});
        socket.end();
        setTimeout(() => socket.destroy(), 1000).unref();
      }
    },
  };
}

/** The deployment's SMTP settings (SMTP_URL, EMAIL_FROM), if it has them. */
export function smtpFromEnv(env: Record<string, string | undefined>): Email | undefined {
  if (!env.SMTP_URL || !env.EMAIL_FROM) return undefined;
  return smtpMailer({ url: env.SMTP_URL, from: env.EMAIL_FROM });
}
