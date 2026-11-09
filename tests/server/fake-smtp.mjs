// A mail server for the server checks: it speaks enough SMTP for
// src/server/smtp.ts (EHLO, STARTTLS when given a certificate, AUTH PLAIN or
// LOGIN when given a password, MAIL, RCPT, DATA, QUIT) and keeps each message
// it's sent, decoded, so a check can read what arrived.
import { createServer } from "node:net";
import { TLSSocket } from "node:tls";

/** Starts it. `tls` ({ key, cert }) offers STARTTLS and then requires it; `login` ({ user, pass }) requires AUTH; `host` is where it listens; `stall` answers STARTTLS and then says nothing more. */
export async function fakeSmtp({ tls, login, host = "127.0.0.1", stall = false } = {}) {
  const received = [];
  const server = createServer((raw) => {
    let socket = raw;
    let secured = false;
    let authed = !login;
    let buffer = "";
    let data = null;
    let mail = { from: "", to: [] };
    let loginStep = 0;
    let loginUser = "";
    const say = (line) => socket.write(`${line}\r\n`);
    const onLine = (line) => {
      if (data !== null) {
        if (line === ".") {
          received.push({ ...mail, raw: data.join("\r\n"), ...decode(data.join("\r\n")) });
          data = null;
          mail = { from: "", to: [] };
          return say("250 Kept");
        }
        return data.push(line.startsWith("..") ? line.slice(1) : line);
      }
      if (loginStep === 1) return (loginUser = Buffer.from(line, "base64").toString()), (loginStep = 2), say("334 UGFzc3dvcmQ6");
      if (loginStep === 2) {
        loginStep = 0;
        authed = loginUser === login.user && Buffer.from(line, "base64").toString() === login.pass;
        return say(authed ? "235 Fine" : "535 No");
      }
      const [verb, ...rest] = line.split(" ");
      const arg = rest.join(" ");
      switch (verb.toUpperCase()) {
        case "EHLO":
          return socket.write(`250-fake.smtp\r\n${tls && !secured ? "250-STARTTLS\r\n" : ""}${login ? "250-AUTH PLAIN LOGIN\r\n" : ""}250 OK\r\n`);
        case "STARTTLS": {
          if (!tls) return say("502 No");
          say("220 Go ahead");
          raw.removeAllListeners("data");
          if (stall) return;
          socket = new TLSSocket(raw, { isServer: true, key: tls.key, cert: tls.cert });
          secured = true;
          buffer = "";
          return socket.on("data", onData);
        }
        case "AUTH": {
          if (tls && !secured) return say("530 STARTTLS first");
          const [kind, b64] = arg.split(" ");
          if (kind.toUpperCase() === "LOGIN") return (loginStep = 1), say("334 VXNlcm5hbWU6");
          const [, user, pass] = Buffer.from(b64 ?? "", "base64").toString().split("\0");
          authed = user === login?.user && pass === login?.pass;
          return say(authed ? "235 Fine" : "535 No");
        }
        case "MAIL":
          if (tls && !secured) return say("530 STARTTLS first");
          if (!authed) return say("530 Sign in first");
          mail.from = /<([^>]*)>/.exec(arg)?.[1] ?? "";
          return say("250 OK");
        case "RCPT":
          mail.to.push(/<([^>]*)>/.exec(arg)?.[1] ?? "");
          return say("250 OK");
        case "DATA":
          data = [];
          return say("354 Go on");
        case "QUIT":
          say("221 Bye");
          return socket.end();
        default:
          return say("500 What?");
      }
    };
    const onData = (chunk) => {
      buffer += chunk.toString();
      let at;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        onLine(line);
      }
    };
    raw.on("data", onData);
    raw.on("error", () => {});
    say("220 fake.smtp ready");
  });
  await new Promise((r, fail) => server.once("error", fail).listen(0, host, r));
  return { port: server.address().port, received, close: () => server.close() };
}

/** The headers and the text (and HTML) of a message as smtp.ts writes it: base64 parts. */
function decode(raw) {
  const [folded, ...body] = raw.split("\r\n\r\n");
  // A long header goes on over lines that start with a space.
  const head = folded.replace(/\r\n[ \t]+/g, " ");
  const header = (name) => new RegExp(`^${name}: (.*)$`, "mi").exec(head)?.[1] ?? "";
  const words = (v) => v.replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, "base64").toString());
  const parts = {};
  const all = raw.split(/\r\n--=_[^\r\n]*/);
  for (const part of all.length > 1 ? all.slice(1) : [raw]) {
    const type = /Content-Type: text\/(plain|html)/i.exec(part)?.[1];
    if (!type) continue;
    const content = part.split("\r\n\r\n").slice(1).join("").replace(/\s+/g, "");
    parts[type] = Buffer.from(content, "base64").toString();
  }
  void body;
  return { subject: words(header("Subject")), headerTo: header("To"), headerFrom: header("From"), text: parts.plain, html: parts.html };
}
