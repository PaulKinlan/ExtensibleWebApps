// An editor talking to one of a space's agents over ACP (src/server/acp.ts,
// std/acp/, scripts/acp-bridge.mjs), on each host. A scripted ACP client
// writes lines to the bridge as an editor would, with a member's agent key:
// it connects to /s/<space>/acp/shelf-keeper, starts a conversation, sends a
// prompt, and sees what the agent says and each tool it calls as they happen.
// A change to the library isn't the agent's own, so it is reviewed: on the
// member's device as always, and in the editor's own prompt when the key was
// made for that editor.
//
// The model is the one the space holds a key for, a stand-in vendor here
// (tests/server/space-model.mjs), told by `vendor.script` what to answer.

import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { bridge } from "../../scripts/acp-bridge.mjs";
import { device } from "./mcp.mjs";
import { KEY } from "./space-model.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (found, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) {
    const value = await found();
    if (value) return value;
  }
  return undefined;
};

/** A scripted ACP client: what an editor does, over the lines `write` sends and the messages `heard` collects. */
function client(write, heard) {
  let id = 0;
  const me = {
    heard,
    /** A request, and its answer (the whole JSON-RPC response). */
    request(method, params, ms = 30_000) {
      const mine = ++id;
      write({ jsonrpc: "2.0", id: mine, method, ...(params ? { params } : {}) });
      return Object.assign(until(() => heard.find((m) => m.id === mine && !m.method), ms), { id: mine });
    },
    notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
    answer: (to, result) => write({ jsonrpc: "2.0", id: to, result }),
    updates: (session) => heard.filter((m) => m.method === "session/update" && m.params?.sessionId === session).map((m) => m.params.update),
    asked: () => heard.filter((m) => m.method === "session/request_permission"),
  };
  return me;
}

/** The client over the bridge, in this process. */
function editor(address, key) {
  const input = new PassThrough();
  const output = new PassThrough();
  const heard = [];
  let rest = "";
  output.on("data", (chunk) => {
    rest += chunk;
    for (let at; (at = rest.indexOf("\n")) !== -1; rest = rest.slice(at + 1)) heard.push(JSON.parse(rest.slice(0, at)));
  });
  const log = [];
  const running = bridge({ address, key, input, output, log: (line) => log.push(line) });
  return Object.assign(client((message) => input.write(`${JSON.stringify(message)}\n`), heard), { log, close: () => (input.end(), running) });
}

const said = (updates) => updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content?.text).join("");
const lastText = (body) => {
  const last = body.messages?.at(-1)?.content;
  return typeof last === "string" ? last : "";
};
const toolResult = (body) => (Array.isArray(body.messages?.at(-1)?.content) ? body.messages.at(-1).content.find((b) => b.type === "tool_result") : undefined);

/**
 * @param {string} base @param {(what: string, ok: unknown, detail?: string) => void} check
 * @param {{ cookie: string, base: string, call: Function }} owner @param {() => any} person makes a new person
 * @param {{ script?: Function }} vendor @param {() => Promise<string>} restart
 */
export async function acpChecks(base, check, owner, person, vendor, restart) {
  await owner.call("/auth/spaces", { name: "desk" });
  const address = `${base}/s/desk/acp/shelf-keeper`;
  const general = (await owner.call("/auth/keys", { space: "desk", name: "Any agent" })).body?.key;
  const made = await owner.call("/auth/keys", { space: "desk", name: "My editor", editor: "shelf-keeper" });
  const mine = made.body?.key;
  const other = (await owner.call("/auth/keys", { space: "desk", name: "Another editor", editor: "stamper" })).body?.key;
  const badEditor = await owner.call("/auth/keys", { space: "desk", name: "x", editor: "Not An Id" });
  check("acp keys: a member makes a key for an editor and one agent, and an agent's id that isn't one is refused with what to write", /^ewa_/.test(mine ?? "") && made.body.made?.plugin === "acp/shelf-keeper" && badEditor.status === 400 && /lowercase/.test(badEditor.body?.error ?? ""), JSON.stringify([made.body?.made, badEditor]));

  const post = (message, { key = mine, connection, origin, to = address, type = "application/json" } = {}) =>
    fetch(to, { method: "POST", headers: { "content-type": type, ...(key ? { authorization: `Bearer ${key}` } : {}), ...(connection ? { "acp-connection-id": connection } : {}), ...(origin ? { origin } : {}) }, body: JSON.stringify(message) }).then(async (r) => ({
      status: r.status,
      connection: r.headers.get("acp-connection-id"),
      body: await r.json().catch(() => null),
    }));
  const hello = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "checks", version: "1" } } };

  const nobody = await post(hello, { key: null });
  const forOther = await post(hello, { key: other });
  const fromPage = await post(hello, { origin: "https://elsewhere.example" });
  const batch = await post([hello]);
  const notJson = await post(hello, { type: "text/plain" });
  check(
    "acp: only a member's agent key gets in, a key made for another agent's editor doesn't, and a page on another site can't call it",
    nobody.status === 401 && /EXTENSIBLE_APP_KEY/.test(nobody.body?.error?.message ?? "") && forOther.status === 401 && fromPage.status === 403 && batch.status === 400 && batch.body?.error?.code === -32600 && notJson.status === 415,
    JSON.stringify([nobody, forOther.status, fromPage.status, batch, notJson.status]),
  );
  const atMcp = await fetch(`${base}/s/desk/mcp/shelf-keeper`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${mine}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  check("acp keys: an editor's key opens only its agent's address, not an MCP door", atMcp.status === 401, String(atMcp.status));

  // Nobody has opened the app in the space yet: the editor is told what to do.
  const early = await post(hello);
  check("acp: an agent the space doesn't know yet says to open its app in the space once", early.status === 200 && /Open the app that links it in the space once/.test(early.body?.error?.message ?? ""), JSON.stringify(early));

  // A member's device opens the app in the space, with a book in the library.
  const phone = await device(base, "desk", owner.cookie);
  phone.app("server-app/editor");
  phone.send({ t: "sync", op: "push", id: 1, changes: [{ collection: "library", id: "dune", base: 0, after: { id: "dune", title: "Dune", author: "Frank Herbert", shelf: "reading" } }] });
  const first = await until(async () => {
    const tried = await post(hello);
    return tried.body?.result ? tried : undefined;
  });
  const info = first?.body?.result;
  check(
    "acp: an editor connects to a space's agent and is told the version, who the agent is and what it takes",
    first?.status === 200 && /^[0-9a-f]{32}$/.test(first.connection ?? "") && info?.protocolVersion === 1 && info.agentInfo?.name === "shelf-keeper" && info.agentInfo.title === "Shelf keeper" && info.agentCapabilities?.loadSession === true && Array.isArray(info.authMethods),
    JSON.stringify(first),
  );
  const noInbox = await post(hello, { key: general, to: `${base}/s/desk/acp/stamper` });
  const noSuch = await post(hello, { key: general, to: `${base}/s/desk/acp/nobody-here` });
  check(
    "acp: an agent that takes no messages, and one that isn't there, each say why and what to do",
    /message: true/.test(noInbox.body?.error?.message ?? "") && /No agent called nobody-here/.test(noSuch.body?.error?.message ?? "") && /shelf-keeper/.test(noSuch.body.error.message),
    JSON.stringify([noInbox.body, noSuch.body]),
  );
  const unconnected = await post({ jsonrpc: "2.0", id: 5, method: "session/new", params: { cwd: "/", mcpServers: [] } });
  const stolen = await post({ jsonrpc: "2.0", id: 5, method: "session/new", params: { cwd: "/", mcpServers: [] } }, { key: general, connection: first?.connection, to: `${base}/s/desk/acp/stamper` });
  check("acp: a message needs the connection it was given, at the address it was given for", unconnected.status === 400 && /initialize/.test(unconnected.body?.error?.message ?? "") && stolen.status === 404, JSON.stringify([unconnected, stolen]));

  // The stream: what the agent says comes there, numbered, and a stream opened again is sent what it missed.
  const made2 = await post({ jsonrpc: "2.0", id: 6, method: "session/new", params: { cwd: "/", mcpServers: [] } }, { connection: first?.connection });
  const stream = async (lastId) => {
    const abort = new AbortController();
    const res = await fetch(address, { headers: { authorization: `Bearer ${mine}`, accept: "text/event-stream", "acp-connection-id": first?.connection, ...(lastId ? { "last-event-id": lastId } : {}) }, signal: abort.signal });
    let text = "";
    const reading = (async () => {
      try {
        for await (const chunk of res.body) text += new TextDecoder().decode(chunk);
      } catch {}
    })();
    await until(() => /\n\n/.test(text.replace(/^retry:[^\n]*\n\n/, "")), 1500);
    abort.abort();
    await reading;
    return { status: res.status, type: res.headers.get("content-type"), ids: [...text.matchAll(/^id: (\d+)$/gm)].map((m) => m[1]), messages: [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1])) };
  };
  const heard = await stream();
  const again = await stream("0");
  const after = await stream(heard.ids.at(-1));
  check(
    "acp: every other answer comes on the connection's event stream, numbered, and a stream opened again gets what came after the last it had",
    made2.status === 202 && heard.status === 200 && heard.type === "text/event-stream" && /^[0-9a-z]+-[0-9a-f]{32}$/.test(heard.messages[0]?.result?.sessionId ?? "") && heard.messages[0].id === 6 && again.messages[0]?.id === 6 && after.messages.length === 0,
    JSON.stringify([made2, heard, again, after]),
  );
  await fetch(address, { method: "DELETE", headers: { authorization: `Bearer ${mine}`, "acp-connection-id": first?.connection } });

  // ---- An editor, through the bridge ----

  const ed = editor(address, mine);
  const init = await ed.request("initialize", hello.params);
  const session = (await ed.request("session/new", { cwd: "/home/me/project", mcpServers: [] }))?.result?.sessionId;
  check("acp, through the bridge: an editor connects and starts a conversation", init?.result?.protocolVersion === 1 && typeof session === "string", JSON.stringify([init, session, ed.log]));

  const noModel = await ed.request("session/prompt", { sessionId: session, prompt: [{ type: "text", text: "Hello" }] });
  check("acp: in a space with no model key, the prompt's error says who can give one and where", /no model key/.test(noModel?.error?.message ?? "") && /\/account\//.test(noModel.error.message), JSON.stringify(noModel));
  const keyed = await owner.call("/auth/spaces/desk/model/key", { vendor: "anthropic", key: KEY });

  // Reading: the model asks for the list, then answers with what it got.
  const seen = [];
  vendor.script = (body) => {
    seen.push(body);
    const result = toolResult(body);
    if (result) return { content: [{ type: "text", text: `On the shelf: ${JSON.parse(result.content).map((b) => b.title).join(", ")}.` }] };
    if (/shelf/.test(lastText(body))) return { content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "tu_list", name: "data_list_library", input: {} }], stop_reason: "tool_use" };
    return undefined;
  };
  const reading = ed.request("session/prompt", { sessionId: session, prompt: [{ type: "text", text: "What is on the shelf?" }, { type: "resource_link", uri: "file:///home/me/notes.md", name: "notes.md" }] });
  const read = await reading;
  const ups = ed.updates(session);
  const call = ups.find((u) => u.sessionUpdate === "tool_call");
  const done = ups.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === call?.toolCallId);
  const order = ed.heard.map((m) => (m.id === reading.id ? "answer" : m.method === "session/update" ? m.params.update.sessionUpdate : "")).filter(Boolean);
  check(
    "acp: a prompt runs the agent, and the editor sees what it says and each tool call as they happen, then the answer",
    keyed.status === 200 && read?.result?.stopReason === "end_turn" && call?.kind === "read" && call.status === "pending" && done?.status === "completed" && /Dune/.test(done.content?.[0]?.content?.text ?? "") && /Let me look\.On the shelf: Dune\./.test(said(ups)) && order.at(-1) === "answer" && order.indexOf("tool_call") < order.indexOf("tool_call_update"),
    JSON.stringify({ read, ups, order }),
  );
  check(
    "acp: the model is given the agent's instructions, only the tools its file grants, and what the person wrote with the files they pointed at",
    /reading list/.test(JSON.stringify(seen[0]?.system ?? "")) && seen[0]?.tools?.some((t) => t.name === "data_put_library") && !seen[0].tools.some((t) => /^(llm_|email_|files_)/.test(t.name)) && /\[notes\.md\]\(file:\/\/\/home\/me\/notes\.md\)/.test(lastText(seen[0])),
    JSON.stringify(seen[0]).slice(0, 600),
  );

  // Changing: the library isn't the agent's, so the change is reviewed, on the device and in the editor.
  const write = { content: [{ type: "tool_use", id: "tu_put", name: "data_put_library", input: { record: { id: "dune", title: "Dune", author: "Frank Herbert", shelf: "done" }, reason: "You finished it" } }], stop_reason: "tool_use" };
  vendor.script = (body) => (toolResult(body) ? { content: [{ type: "text", text: /Error/.test(toolResult(body).content) ? "It wasn't changed." : "Marked as done." }] } : /finish/.test(lastText(body)) ? write : undefined);
  const changing = ed.request("session/prompt", { sessionId: session, prompt: [{ type: "text", text: "I finished Dune." }] });
  const asked = await until(() => ed.asked().at(-1));
  const onPhone = await until(() => phone.reviews().at(-1));
  const options = asked?.params?.options ?? [];
  check(
    "acp: a change the agent asks for shows as a review card on the member's device and as a permission request in the editor, with its reason and what changes",
    asked?.params?.sessionId === session && /You finished it/.test(JSON.stringify(asked.params.toolCall)) && /done/.test(JSON.stringify(asked.params.toolCall)) && options.map((o) => o.kind).join() === "allow_once,allow_always,reject_once" && onPhone?.review?.reason === "You finished it" && onPhone.review.plugin === "shelf-keeper",
    JSON.stringify({ asked, onPhone }),
  );
  ed.answer(asked?.id, { outcome: { outcome: "selected", optionId: "allow-once" } });
  const changed = await changing;
  const change = await until(() => phone.changes().filter((c) => c.id === "dune" && c.after?.shelf === "done").at(-1), 5000);
  check(
    "acp: accepted in the editor, the change is made as the agent's, the device's card is settled, and the turn goes on",
    changed?.result?.stopReason === "end_turn" && change?.by === "plugin:shelf-keeper" && /Marked as done/.test(said(ed.updates(session))) && phone.heard.some((m) => m.op === "review" && m.action === "done" && m.id === onPhone?.id),
    JSON.stringify({ changed, change }),
  );
  check("acp: a later prompt in the same conversation is sent with what was said before", seen.length && vendor.asked.length && JSON.stringify(seen).includes("What is on the shelf?"), "");

  // Declined in the editor: nothing is changed, and the agent is told.
  vendor.script = (body) => (toolResult(body) ? { content: [{ type: "text", text: /Error/.test(toolResult(body).content) ? "It wasn't changed." : "Marked." }] } : { content: [{ type: "tool_use", id: "tu_put2", name: "data_put_library", input: { record: { id: "dune", title: "Dune", author: "Nobody", shelf: "done" }, reason: "A guess" } }], stop_reason: "tool_use" });
  const before = ed.asked().length;
  const declining = ed.request("session/prompt", { sessionId: session, prompt: [{ type: "text", text: "Guess the author." }] });
  const second = await until(() => ed.asked()[before]);
  ed.answer(second?.id, { outcome: { outcome: "selected", optionId: "reject" } });
  const declined = await declining;
  const failed = ed.updates(session).filter((u) => u.sessionUpdate === "tool_call_update").at(-1);
  check("acp: declined in the editor, the change isn't made and the agent hears so", declined?.result?.stopReason === "end_turn" && failed?.status === "failed" && /It wasn't changed/.test(said(ed.updates(session))) && !phone.changes().some((c) => c.after?.author === "Nobody"), JSON.stringify({ declined, failed }));

  // Cancelling: the answer is `cancelled`, without waiting for the model.
  let release;
  vendor.script = () => new Promise((r) => (release = () => r({ content: [{ type: "text", text: "Too late." }] })));
  const slow = ed.request("session/prompt", { sessionId: session, prompt: [{ type: "text", text: "Think for a long time." }] });
  await until(() => release, 5000);
  const started = Date.now();
  ed.notify("session/cancel", { sessionId: session });
  const cancelled = await slow;
  const took = Date.now() - started;
  release?.();
  check("acp: cancelling a turn answers `cancelled` at once, without waiting for the model", cancelled?.result?.stopReason === "cancelled" && took < 3000, JSON.stringify({ cancelled, took }));
  await ed.close();

  // ---- A key that wasn't made for the editor can talk to the agent, but can't answer for the person ----

  const plain = editor(address, general);
  await plain.request("initialize", hello.params);
  const plainSession = (await plain.request("session/new", { cwd: "/", mcpServers: [] }))?.result?.sessionId;
  const mineToo = await plain.request("session/load", { sessionId: session });
  // Another member of the space, with a key of their own, can't take up someone else's conversation.
  const mel = await person().account("Mel");
  await mel.call("/auth/invites/accept", { token: (await owner.call("/auth/spaces/desk/invite", {})).body?.token });
  const theirs = editor(address, (await mel.call("/auth/keys", { space: "desk", name: "Mel's editor", editor: "shelf-keeper" })).body?.key);
  await theirs.request("initialize", hello.params);
  const notTheirs = await theirs.request("session/load", { sessionId: session });
  const prompted = await theirs.request("session/prompt", { sessionId: session, prompt: [{ type: "text", text: "Hello" }] });
  await theirs.close();
  vendor.script = (body) => (toolResult(body) ? { content: [{ type: "text", text: "Moved." }] } : { content: [{ type: "tool_use", id: "tu_put3", name: "data_put_library", input: { record: { id: "dune", title: "Dune", author: "Frank Herbert", shelf: "reading" }, reason: "Back on the pile" } }], stop_reason: "tool_use" });
  const reviewsBefore = phone.reviews().length;
  const waiting = plain.request("session/prompt", { sessionId: plainSession, prompt: [{ type: "text", text: "Put Dune back." }] });
  const third = await until(() => phone.reviews()[reviewsBefore]);
  const told = await until(() => plain.updates(plainSession).find((u) => u.sessionUpdate === "tool_call_update" && /Waiting for your answer in the app/.test(u.title ?? "")));
  // Whatever such a client sends as an answer, the review still waits for the device.
  plain.answer("review-000000000000", { outcome: { outcome: "selected", optionId: "allow-once" } });
  await wait(400);
  const still = !plain.heard.some((m) => m.id === waiting.id);
  phone.send({ t: "sync", op: "review", action: "answer", id: third?.id, outcome: "allowed-once" });
  const moved = await waiting;
  check(
    "acp: with a key not made for the editor, the review waits on the member's device, the editor says where, and nothing the client sends answers it",
    plain.asked().length === 0 && /make a key for it/.test(JSON.stringify(told ?? "")) && still && moved?.result?.stopReason === "end_turn" && /Moved/.test(said(plain.updates(plainSession))),
    JSON.stringify({ asked: plain.asked(), told, still, moved }),
  );
  check(
    "acp: a conversation belongs to the member who started it: they can load it with any of their keys, and another member can't load it or write in it",
    mineToo?.result && plain.updates(session).some((u) => u.sessionUpdate === "user_message_chunk") && notTheirs?.error?.code === -32002 && /Start a new one/.test(notTheirs.error.message) && prompted?.error?.code === -32002 && theirs.updates(session).length === 0,
    JSON.stringify({ mineToo, notTheirs, prompted }),
  );
  await plain.close();
  phone.close();

  // ---- After the space's server stopped: the conversation is still there, through the command an editor starts ----

  const url = await restart();
  const child = spawn(process.execPath, ["scripts/extensible-app.mjs", "acp", `${url}/s/desk/acp/shelf-keeper`], { env: { ...process.env, EXTENSIBLE_APP_KEY: mine }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  let rest = "";
  child.stdout.on("data", (chunk) => {
    rest += chunk;
    for (let at; (at = rest.indexOf("\n")) !== -1; rest = rest.slice(at + 1)) lines.push(JSON.parse(rest.slice(0, at)));
  });
  const cli = client((message) => child.stdin.write(`${JSON.stringify(message)}\n`), lines);
  const back = await until(async () => {
    const tried = await cli.request("initialize", hello.params, 5000);
    return tried?.result ? tried : undefined;
  }, 40_000);
  const loaded = await cli.request("session/load", { sessionId: session, cwd: "/", mcpServers: [] });
  const replayed = cli.updates(session);
  vendor.script = (body) => ({ content: [{ type: "text", text: `I remember ${body.messages.length} messages.` }] });
  const more = await cli.request("session/prompt", { sessionId: session, prompt: [{ type: "text", text: "And now?" }] });
  const remembered = Number(/remember (\d+)/.exec(said(cli.updates(session)))?.[1] ?? 0);
  check(
    "acp, through `extensible-app acp`: after the space's server restarted, a conversation is loaded with what was said in it, and goes on from there",
    back?.result?.protocolVersion === 1 && loaded?.result && replayed.some((u) => u.sessionUpdate === "user_message_chunk" && /What is on the shelf/.test(u.content?.text ?? "")) && replayed.some((u) => u.sessionUpdate === "agent_message_chunk" && /Marked as done/.test(u.content?.text ?? "")) && !JSON.stringify(replayed).includes("Think for a long time") && more?.result?.stopReason === "end_turn" && remembered > 4,
    JSON.stringify({ back, loaded, replayed: replayed.length, more, remembered }),
  );
  const unknown = await cli.request("session/list", {});
  check("acp: a method this agent doesn't have is a JSON-RPC error", unknown?.error?.code === -32601, JSON.stringify(unknown));

  // Revoking the key shuts the editor out, in words it can show.
  await owner.call("/auth/keys/revoke", { id: made.body?.made?.id });
  const shut = await cli.request("session/new", { cwd: "/", mcpServers: [] });
  check("acp keys: a revoked key gets nothing more, and the editor is told to make one", /agent key/.test(shut?.error?.message ?? ""), JSON.stringify(shut));
  child.stdin.end();
  const exited = await until(() => child.exitCode !== null, 8000);
  check("acp: the command ends when the editor closes its end", exited, String(child.exitCode));
  if (!exited) child.kill();
  vendor.script = undefined;
  return url;
}
