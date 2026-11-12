// `extensible-app acp <address>`: how an editor talks to one of a space's
// agents. ACP (the Agent Client Protocol, https://agentclientprotocol.com) has
// an editor start an agent as a program and write JSON-RPC to it, one message
// a line, on its standard input and output. The agents here live on a space's
// server, so this is that program: it passes each line on to the agent's
// address, /s/<space>/acp/<agent> (src/server/acp.ts), and writes out what
// the agent says.
//
//   EXTENSIBLE_APP_KEY=ewa_…  extensible-app acp https://example.com/s/home/acp/assistant
//
// The key is an agent key the person made on /account/ for the space. It is
// read from the environment, never from the command line, where other
// programs on the machine could see it.
//
// What it does: each line from the editor is POSTed to the address. The
// answer to `initialize` comes back with that POST, with the connection's id;
// everything after it comes on one event stream, which is kept open and
// opened again from where it stopped if it drops. Nothing but ACP messages is
// written to standard output; what goes wrong is said to the editor as a
// JSON-RPC error whose message says what to do, and on standard error.

import { createInterface } from "node:readline";

const ADDRESS = /^\/s\/[^/]+\/acp\/[a-z0-9][a-z0-9-]{0,63}\/?$/;

/** The address, checked: an agent's address on a site reached safely. Throws what to write instead. */
export function agentAddress(given) {
  let url;
  try {
    url = new URL(String(given ?? ""));
  } catch {
    throw new Error("Give the agent's address, such as https://example.com/s/home/acp/assistant");
  }
  if (!ADDRESS.test(url.pathname)) throw new Error(`${url.href} isn't an agent's address: it ends /s/<space>/acp/<agent id>`);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("The address must start https:// (your key is sent to it), or http://localhost while developing");
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * Runs the bridge until the editor closes its end. `input` and `output` are the editor's side (lines of JSON);
 * `log` takes what a person reading the editor's logs should see.
 * @param {{ address: string, key?: string, input: NodeJS.ReadableStream, output: { write(text: string): unknown }, log?: (text: string) => void, fetch?: typeof fetch }} options
 */
export async function bridge({ address, key, input, output, log = () => {}, fetch: send = fetch }) {
  const site = new URL(address).origin;
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  const fail = (id, message, code = -32000) => write({ jsonrpc: "2.0", id, error: { code, message } });
  const headers = () => ({ authorization: `Bearer ${key}`, ...(connection ? { "acp-connection-id": connection } : {}) });
  /** The connection's id, once the agent answered `initialize`. */
  let connection = "";
  /** The last message the stream delivered: a stream opened again asks for what came after it. */
  let last = "0";
  let closed = false;
  /** Stops the stream that is open now. */
  let hangUp = () => {};
  /** The editor's requests that haven't been answered: told what happened if the agent can no longer be reached. */
  const waiting = new Set();
  /** The POSTs under way, so closing waits for them to be sent. */
  const sending = new Set();

  const said = async (response) => {
    const body = await response.json().catch(() => null);
    return body?.error?.message ?? `${site} answered ${response.status}`;
  };

  /** The agent's stream: opened once connected, and again from where it stopped for as long as the editor is there. */
  async function listen() {
    let wait = 1000;
    while (!closed) {
      const abort = new AbortController();
      hangUp = () => abort.abort();
      try {
        const response = await send(address, { headers: { ...headers(), accept: "text/event-stream", "last-event-id": last }, signal: abort.signal });
        if (!response.ok || !response.body) {
          const why = await said(response);
          // The key stopped working, or the connection is someone else's: opening it again won't help.
          if (response.status === 401 || response.status === 403 || response.status === 404) {
            log(`The agent's stream was refused: ${why}`);
            for (const id of waiting) fail(id, why);
            waiting.clear();
            return;
          }
          throw new Error(why);
        }
        wait = 1000;
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
            let id = "";
            const data = [];
            for (const line of event.split(/\r?\n/)) {
              if (line.startsWith("id:")) id = line.slice(3).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
              else if (line.startsWith("retry:")) wait = Math.max(250, Number(line.slice(6)) || wait);
            }
            if (!data.length) continue;
            // One it has had already (the stream was opened again a moment too early) isn't said twice.
            if (/^\d+$/.test(id) && BigInt(id) <= BigInt(last)) continue;
            if (/^\d+$/.test(id)) last = id;
            let message;
            try {
              message = JSON.parse(data.join("\n"));
            } catch {
              continue;
            }
            if (message && "id" in message && !("method" in message)) waiting.delete(message.id);
            write(message);
          }
        }
      } catch (error) {
        if (closed) return;
        log(`The agent's stream stopped (${error instanceof Error ? error.message : error}); opening it again`);
      }
      if (closed) return;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 15_000);
    }
  }

  /** Passes one of the editor's messages on. */
  async function pass(message) {
    const request = message && typeof message === "object" && typeof message.method === "string" && message.id !== undefined && message.id !== null;
    const id = request ? message.id : undefined;
    if (!key) return request && fail(id, "This agent needs a key. Make one on " + site + "/account/ (Agent keys), and set it for this command as EXTENSIBLE_APP_KEY.");
    const first = message?.method === "initialize";
    if (!first && !connection) return request && fail(id, "Not connected to the agent: its answer to `initialize` said why.");
    if (request && !first) waiting.add(id);
    let response;
    try {
      response = await send(address, { method: "POST", headers: { ...(first ? { authorization: `Bearer ${key}` } : headers()), "content-type": "application/json" }, body: JSON.stringify(message) });
    } catch (error) {
      waiting.delete(id);
      return request && fail(id, `Couldn't reach ${site} (${error instanceof Error ? (error.cause?.message ?? error.message) : error}). Check your connection, then send it again.`);
    }
    if (first) {
      const body = await response.json().catch(() => null);
      const made = response.headers.get("acp-connection-id");
      if (!body || typeof body !== "object") return fail(id, `${site} answered ${response.status}, which isn't an agent's answer. Check the address: ${address}`);
      if (response.ok && made) {
        connection = made;
        void listen();
      }
      // The agent's own answer, or its error saying what to do (no such agent, no key), as it sent it.
      return write({ ...body, id: body.id ?? id });
    }
    if (!response.ok) {
      waiting.delete(id);
      const why = await said(response);
      log(`${message?.method ?? "An answer"} was refused: ${why}`);
      return request && fail(id, why);
    }
    // Taken: what the agent says to it comes on the stream.
    await response.arrayBuffer().catch(() => {});
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(null, "Not JSON", -32700);
      continue;
    }
    // Sent as they come, without waiting for the one before: a prompt's POST stays open for the whole turn, and a
    // cancel or an answer to a review has to get through meanwhile. `initialize` alone is waited for.
    const sent = pass(message).catch((error) => log(String(error instanceof Error ? error.message : error)));
    if (message?.method === "initialize") await sent;
    else {
      sending.add(sent);
      void sent.finally(() => sending.delete(sent));
    }
  }

  // The editor closed its end: the connection ends, and any turn under way with it.
  closed = true;
  hangUp();
  if (connection) await send(address, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(5000) }).catch(() => {});
}

/** The command: `extensible-app acp <address>`. */
export async function main(args) {
  if (args.length !== 1) throw Object.assign(new Error("extensible-app acp <address>   the agent's address, such as https://example.com/s/home/acp/assistant\n  Its key (an agent key from the site's /account/ page) is read from EXTENSIBLE_APP_KEY."), { code: 2 });
  const address = agentAddress(args[0]);
  const key = process.env.EXTENSIBLE_APP_KEY?.trim();
  if (!key) process.stderr.write("EXTENSIBLE_APP_KEY isn't set: the agent will say it needs a key.\n");
  await bridge({ address, key, input: process.stdin, output: process.stdout, log: (text) => process.stderr.write(`${text}\n`) });
}
