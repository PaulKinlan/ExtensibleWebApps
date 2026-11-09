// A space's MCP server (src/server/mcp.ts, std/outside/module.ts), on each
// host: a member makes an agent key on /account/, an agent outside the
// browser connects with it to /s/<space>/mcp/reading-list-agents, lists the
// reading list's tools, reads the library, and changes it. The change is the
// door's plugin's, to a collection it doesn't own, so the space sends the
// review to the member's device (src/kernel/space-reviews.ts), which answers.

/** A member's device in the space, speaking sync, that can answer the space's reviews. */
async function device(base, space, cookie) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/s/${space}/kernel`, { headers: { cookie } });
  const heard = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "sync") heard.push(m);
  };
  await new Promise((open, fail) => {
    ws.onopen = open;
    ws.onerror = () => fail(new Error("Couldn't connect"));
  });
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: "hello", tab: `device-${Math.random().toString(36).slice(2)}` });
  send({ t: "sync", op: "hello", since: 0 });
  return {
    heard,
    send,
    app: (app) => send({ t: "sync", op: "app", app }),
    reviews: () => heard.filter((m) => m.op === "review" && m.action === "ask"),
    changes: () => heard.filter((m) => m.op === "changes").flatMap((m) => m.changes),
    close: () => ws.close(),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function mcpChecks(base, check, owner, stranger) {
  await owner.call("/auth/spaces", { name: "shelf" });
  await owner.call("/auth/spaces", { name: "elsewhere" });
  const made = await owner.call("/auth/keys", { space: "shelf", name: "Claude Code" });
  const key = made.body?.key;
  check("agent keys: a member makes a key for a space, shown once, named after its agent", made.status === 200 && /^ewa_/.test(key ?? "") && made.body.made?.name === "Claude Code", JSON.stringify(made));
  const listed = await owner.call("/auth/keys");
  check("agent keys: the list names each key and its space, never the key itself", listed.body?.keys?.length === 1 && listed.body.keys[0].space === "shelf" && !JSON.stringify(listed.body).includes(key), JSON.stringify(listed.body));
  const notMine = await owner.call("/auth/keys", { space: "no-such-space", name: "x" });
  check("agent keys: only for a space you're in", notMine.status === 403, String(notMine.status));

  const address = `${base}/s/shelf/mcp/reading-list-agents`;
  let id = 0;
  const rpc = (method, params, { auth = key, origin } = {}) =>
    fetch(address, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(origin ? { origin } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  const nobody = await rpc("tools/list", undefined, { auth: null });
  const forged = await rpc("tools/list", undefined, { auth: "ewa_" + "x".repeat(43) });
  const otherKey = (await owner.call("/auth/keys", { space: "elsewhere", name: "Other" })).body?.key;
  const wrongSpace = await rpc("tools/list", undefined, { auth: otherKey });
  check("mcp: only a member's agent key for this space gets in", nobody.status === 401 && forged.status === 401 && wrongSpace.status === 401, JSON.stringify([nobody.status, forged.status, wrongSpace.status]));
  const huge = await fetch(address, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping", params: { pad: "x".repeat(300 * 1024) } }) });
  check("mcp: a body over the limit is refused with a JSON-RPC error", huge.status === 413 && (await huge.json().catch(() => null))?.error?.message, String(huge.status));
  const fromPage = await rpc("tools/list", undefined, { origin: "https://elsewhere.example" });
  check("mcp: a page on another site can't call it from someone's browser", fromPage.status === 403, String(fromPage.status));

  // A member's device opens the reading list in the space: the space starts its plugins that run there, outside-agents.js among them.
  const phone = await device(base, "shelf", owner.cookie);
  phone.app("demos/reading-list");
  phone.send({ t: "sync", op: "push", id: 1, changes: [{ collection: "library", id: "dune", base: 0, after: { id: "dune", title: "Dune", author: "Frank Herbert", shelf: "reading" } }] });
  let init;
  for (let i = 0; i < 40 && init?.body?.result?.serverInfo?.name !== "Outside agent"; i++) {
    if (i) await wait(250);
    init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "checks", version: "1" } });
  }
  check("mcp: an agent connects to the space with its key and is told what the app is for", init?.status === 200 && init.body?.result?.protocolVersion && /reading list/.test(init.body.result.instructions ?? ""), JSON.stringify(init));
  const note = await fetch(address, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  check("mcp: a notification is taken, with nothing to answer", note.status === 202, String(note.status));

  const tools = await rpc("tools/list");
  const names = (tools.body?.result?.tools ?? []).map((t) => t.name);
  check("mcp: the agent lists the door's plugin's tools, and only those its manifest grants", ["data_list_library", "data_put_library"].every((n) => names.includes(n)) && !names.some((n) => /^(llm_|tools_|email_)/.test(n)), names.join(","));

  const read = await rpc("tools/call", { name: "data_list_library", arguments: {} });
  const books = JSON.parse(read.body?.result?.content?.[0]?.text ?? "[]");
  check("mcp: another agent reads a demo app's data over MCP", books.some((b) => b.title === "Dune"), JSON.stringify(read.body));

  // A change: the library isn't the door's plugin's, so the space asks the member's device to review it.
  const writing = rpc("tools/call", { name: "data_put_library", arguments: { record: { id: "dune", title: "Dune", author: "Frank Herbert", shelf: "done" }, reason: "You finished it" } });
  let review;
  for (let i = 0; i < 40 && !review; i++) {
    await wait(250);
    review = phone.reviews().at(-1);
  }
  check("mcp: a change an agent asks for is sent to the member's device as a review, with its reason and diff", review?.review?.reason === "You finished it" && /done/.test(review.review.after) && /reading/.test(review.review.before), JSON.stringify(review));
  phone.send({ t: "sync", op: "review", action: "answer", id: review?.id, outcome: "allowed-once" });
  const written = await writing;
  await wait(500);
  const change = phone.changes().filter((c) => c.id === "dune").at(-1);
  check("mcp: another agent changes a demo app's data over MCP, once the member accepts", written.body?.result?.isError === false && change?.after?.shelf === "done" && change.by === "plugin:reading-list-agents", JSON.stringify({ written: written.body, change }));
  check("mcp: the space tells devices the review is settled", phone.heard.some((m) => m.op === "review" && m.action === "done" && m.id === review?.id));

  const declining = rpc("tools/call", { name: "data_delete_library", arguments: { id: "dune", reason: "Tidying" } });
  let second;
  for (let i = 0; i < 40 && !second; i++) {
    await wait(250);
    second = phone.reviews().find((r) => r.id !== review?.id);
  }
  phone.send({ t: "sync", op: "review", action: "answer", id: second?.id, outcome: "rejected" });
  const declined = await declining;
  check("mcp: a change the member declines isn't made, and the agent is told so as the tool's result", declined.body?.result?.isError === true && /declined/.test(declined.body.result.content?.[0]?.text ?? ""), JSON.stringify(declined.body));

  const unknown = await rpc("resources/list");
  const missing = await rpc("tools/call", { name: "files_read", arguments: { path: "x" } });
  check("mcp: an unknown method is a JSON-RPC error, a tool the plugin wasn't offered fails", unknown.body?.error?.code === -32601 && missing.body?.result?.isError === true, JSON.stringify([unknown.body, missing.body]));

  // A stranger's device can't answer a space's review, and revoking the key shuts the agent out.
  const revoked = await owner.call("/auth/keys/revoke", { id: made.body?.made?.id });
  const after = await rpc("tools/list");
  check("agent keys: a revoked key gets nothing", revoked.status === 200 && after.status === 401, JSON.stringify([revoked.status, after.status]));
  const strangerKey = await stranger.call("/auth/keys", { space: "shelf", name: "Sneaky" });
  check("agent keys: someone not in the space can't make a key for it", strangerKey.status === 403 || strangerKey.status === 401, String(strangerKey.status));
  phone.close();
}
