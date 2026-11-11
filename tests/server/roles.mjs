// Who may change what in a space (src/server/auth/accounts.ts for the roles,
// src/server/signed.ts and std/spaces/permissions.ts for what the space's
// server lets through), the same on every host: the owner gives each member a
// role; a reader's changes are refused on the server whatever their client
// sends, with words that say whom to ask; and a collection's rules in its
// plugin's manifest ("only whoever added it changes it") hold for editors.
//
// The app is tests/fixtures/server-app/, whose ledger.js keeps `ledger-entries`
// (change and remove: "author"), `notices` (add and remove: "owner") and
// `muddle`, whose rules can't be read.

/**
 * @param {string} base @param {(what: string, ok: unknown, detail?: string) => void} check
 * @param {{ cookie: string, base: string, call: Function }} owner @param {() => any} person makes a new person
 * @param {{ device: Function, client: Function }} tools the runner's device (speaks sync) and client (runs commands)
 * @param {() => Promise<string>} restart
 */
export async function roleChecks(base, check, owner, person, { device, client }, restart) {
  await owner.call("/auth/spaces", { name: "club" });
  const invite = async (role) => (await owner.call("/auth/spaces/club/invite", role ? { role } : {})).body;
  const ed = await person().account("Ed");
  const rae = await person().account("Rae");
  const bad = await owner.call("/auth/spaces/club/invite", { role: "admin" });
  const asEditor = await invite();
  const asReader = await invite("reader");
  await ed.call("/auth/invites/accept", { token: asEditor?.token });
  const joined = await rae.call("/auth/invites/accept", { token: asReader?.token });
  const members = (await owner.call("/auth/spaces/club")).body?.members ?? [];
  const id = (name) => members.find((m) => m.name === name)?.id;
  const mine = (await rae.call("/auth/spaces")).body?.spaces ?? [];
  check(
    "roles: the owner invites someone as an editor or as a reader, and everyone sees who is what",
    bad.status === 400 && /editor.*reader/.test(bad.body?.error ?? "") && asEditor?.role === "editor" && joined.body?.space?.role === "reader" && members.find((m) => m.name === "Ed")?.role === "editor" && members.find((m) => m.name === "Rae")?.role === "reader" && members.find((m) => m.name === "Owner")?.role === "owner" && mine.find((s) => s.name === "club")?.role === "reader",
    JSON.stringify({ bad, asEditor, joined, members, mine }),
  );

  const byEditor = await ed.call("/auth/spaces/club/role", { user: id("Rae"), role: "editor" });
  const toOwner = await owner.call("/auth/spaces/club/role", { user: id("Ed"), role: "owner" });
  const ofOwner = await owner.call("/auth/spaces/club/role", { user: id("Owner"), role: "reader" });
  const stranger = await owner.call("/auth/spaces/club/role", { user: "nobody", role: "reader" });
  check(
    "roles: only the owner changes a role, to editor or reader, and never the owner's own",
    byEditor.status === 403 && /owner/.test(byEditor.body?.error ?? "") && toOwner.status === 400 && /one owner/.test(toOwner.body?.error ?? "") && ofOwner.status === 400 && stranger.status === 404,
    JSON.stringify([byEditor, toOwner, ofOwner, stranger]),
  );

  // The space reads the app's plugins, and so the rules of the collections they keep.
  const ownerPhone = await device(base, "club", owner.cookie);
  await ownerPhone.hello(0);
  ownerPhone.app("server-app");
  await new Promise((r) => setTimeout(r, 2500));

  const edPhone = await device(base, "club", ed.cookie);
  const raePhone = await device(base, "club", rae.cookie);
  await edPhone.hello(0);
  await raePhone.hello(0);
  const told = (d) => d.heard.find((m) => m.op === "changes");
  check(
    "roles: the space tells each device what its member may do, the rules of each collection, and the owner's name",
    told(raePhone)?.role === "reader" && told(edPhone)?.role === "editor" && told(edPhone)?.rules?.["ledger-entries"]?.change === "author" && told(edPhone)?.rules?.notices?.add === "owner" && told(edPhone)?.owner === "Owner",
    JSON.stringify([told(raePhone), told(edPhone)]),
  );

  const kept = await edPhone.push([{ collection: "books", id: "emma", base: 0, after: { id: "emma", title: "Emma" } }]);
  const refused = await raePhone.push([
    { collection: "books", id: "persuasion", base: 0, after: { id: "persuasion", title: "Persuasion" } },
    { collection: "books", id: "emma", base: kept?.[0]?.seq ?? 0, after: { id: "emma", title: "Emma, defaced" } },
    { collection: "books", id: "emma", base: kept?.[0]?.seq ?? 0, after: null },
  ]);
  await edPhone.settle();
  const after = edPhone.changes().filter((c) => c.collection === "books" && (c.id === "persuasion" || (c.id === "emma" && c.after?.title !== "Emma")));
  check(
    "roles: a reader's changes (a new record, an edit, a delete) are refused on the server, saying whom to ask, and nothing reaches the others",
    kept?.[0]?.ok && refused?.length === 3 && refused.every((r) => r.ok === false && r.denied === true && /You can read this space but not change it\. Ask the space's owner, Owner, to make you an editor\./.test(r.error ?? "")) && refused[1].record?.title === "Emma" && after.length === 0,
    JSON.stringify({ kept, refused, after }),
  );

  // Whatever else a reader's client sends that would change the space never reaches its kernel.
  const raeClient = await client(base, "club", rae.cookie);
  const plugin = 'export const manifest = { id: "sneak", name: "Sneak", permissions: [] };\nexport default () => {};';
  const added = await raeClient.command("user:add", { app: "demos/contacts", files: [{ name: "sneak.js", data: plugin }] }).catch((e) => String(e));
  const installed = await raeClient.command("install", "/server-app/ghost.js").catch((e) => String(e));
  const reads = await raeClient.command("reference");
  raeClient.close();
  const ownerClient = await client(base, "club", owner.cookie);
  const listed = await ownerClient.command("user:list", { app: "demos/contacts" });
  const ok = await ownerClient.command("user:add", { app: "demos/contacts", files: [{ name: "sneak.js", data: plugin }] });
  ownerClient.close();
  check(
    "roles: a reader's client can't run a command that changes the space (adding a plugin, installing one), but can still read; the owner's can",
    added === undefined && installed === undefined && !!reads?.data && Array.isArray(listed) && listed.length === 0 && ok?.ok === true,
    JSON.stringify({ added, installed, reads: !!reads?.data, listed, ok }),
  );

  // Sharing a plugin with the space is a change too: refused in the shape the device waits for.
  const shareId = 77;
  raePhone.send({ t: "sync", op: "plugins", id: shareId, action: "add", app: "demos/contacts", files: [{ name: "sneak.js", text: plugin }] });
  raePhone.send({ t: "sync", op: "plugins", id: shareId + 1, action: "list" });
  await raePhone.settle();
  const shared = raePhone.heard.find((m) => m.op === "plugins:reply" && m.id === shareId);
  const list = raePhone.heard.find((m) => m.op === "plugins:reply" && m.id === shareId + 1);
  check("roles: a reader can't share a plugin with the space, and is told why; listing what is shared still answers", shared?.ok === false && /read this space but not change it/.test(shared.error ?? "") && list?.ok === true, JSON.stringify({ shared, list }));

  // A reader can't claim another role: the server says what each client is.
  const liar = await device(base, "club", rae.cookie, { claim: id("Owner") });
  await liar.hello(0);
  liar.send({ t: "sync", op: "push", id: 900, role: "owner", changes: [{ collection: "books", id: "lie", base: 0, after: { id: "lie", title: "Lie" } }] });
  await liar.settle();
  await edPhone.settle();
  check("roles: a client that says it has another role is still what the server says it is", !edPhone.changes().some((c) => c.id === "lie"), JSON.stringify(edPhone.changes().filter((c) => c.id === "lie")));
  liar.close();

  // A reader's agent could change what the reader can't, so a reader gets no key for one.
  const key = await rae.call("/auth/keys", { space: "club", name: "My agent" });
  const edKey = await ed.call("/auth/keys", { space: "club", name: "Ed's agent" });
  check("roles: a reader can't make an agent's key for the space, and is told to ask for another role; an editor can", key.status === 403 && /make you an editor/.test(key.body?.error ?? "") && edKey.status === 200 && typeof edKey.body?.key === "string", JSON.stringify([key, edKey.status]));

  // Rules: only whoever added an entry changes or removes it; the owner may always.
  const mineE = await edPhone.push([{ collection: "ledger-entries", id: "e1", base: 0, after: { id: "e1", text: "Ed's" } }]);
  const owners = await ownerPhone.push([{ collection: "ledger-entries", id: "o1", base: 0, after: { id: "o1", text: "Owner's" } }]);
  const edOnOwners = await edPhone.push([{ collection: "ledger-entries", id: "o1", base: owners?.[0]?.seq, after: { id: "o1", text: "Ed was here" } }]);
  const edRemoves = await edPhone.push([{ collection: "ledger-entries", id: "o1", base: owners?.[0]?.seq, after: null }]);
  const edOnOwn = await edPhone.push([{ collection: "ledger-entries", id: "e1", base: mineE?.[0]?.seq, after: { id: "e1", text: "Ed's, edited" } }]);
  const ownerOnEds = await ownerPhone.push([{ collection: "ledger-entries", id: "e1", base: edOnOwn?.[0]?.seq, after: { id: "e1", text: "Tidied by the owner" } }]);
  check(
    'rules: under "author", an editor changes and removes only what they added, is told who can change the rest, and the owner changes anything',
    mineE?.[0]?.ok && owners?.[0]?.ok && edOnOwners?.[0]?.denied === true && /Owner added this, so only Owner or the space's owner, Owner, can change it\./.test(edOnOwners[0].error ?? "") && edOnOwners[0].record?.text === "Owner's" && edRemoves?.[0]?.denied === true && /can remove it/.test(edRemoves[0].error ?? "") && edOnOwn?.[0]?.ok && ownerOnEds?.[0]?.ok,
    JSON.stringify({ mineE, owners, edOnOwners, edRemoves, edOnOwn, ownerOnEds }),
  );

  const edPosts = await edPhone.push([{ collection: "notices", id: "n1", base: 0, after: { id: "n1", text: "Party" } }]);
  const ownerPosts = await ownerPhone.push([{ collection: "notices", id: "n1", base: 0, after: { id: "n1", text: "Bins on Monday" } }]);
  const edEdits = await edPhone.push([{ collection: "notices", id: "n1", base: ownerPosts?.[0]?.seq, after: { id: "n1", text: "Bins on Tuesday" } }]);
  const edDeletes = await edPhone.push([{ collection: "notices", id: "n1", base: edEdits?.[0]?.seq, after: null }]);
  check(
    'rules: under add and remove "owner", an editor can\'t add or remove but can change, as the rules say',
    edPosts?.[0]?.denied === true && /Only the space's owner, Owner, can add to Notices\./.test(edPosts[0].error ?? "") && ownerPosts?.[0]?.ok && edEdits?.[0]?.ok && edDeletes?.[0]?.denied === true && /can remove this in Notices/.test(edDeletes[0].error ?? ""),
    JSON.stringify({ edPosts, ownerPosts, edEdits, edDeletes }),
  );

  // A form's record, as a page says it to its own kernel, would be written as the plugin it names, past the rules.
  // A space's server draws no forms: it never hears one from a member's client.
  const viewer = await client(base, "club", ed.cookie);
  viewer.send({ t: "record", id: "r1", owner: "ledger", collection: "notices", fields: { text: "Written as the plugin" }, trace: "x" });
  viewer.send({ t: "event", owner: "plugins", action: "off:ledger", trace: "x" });
  await new Promise((r) => setTimeout(r, 1000));
  const answered = viewer.heard.filter((m) => m.t === "record:result");
  const sneaked = ownerPhone.changes().filter((c) => c.collection === "notices" && c.after?.text === "Written as the plugin");
  viewer.close();
  check("rules: a member's client can't write as one of the space's plugins, past a collection's rules", answered.length === 0 && sneaked.length === 0, JSON.stringify({ answered, sneaked }));

  const muddled = await edPhone.push([{ collection: "muddle", id: "m1", base: 0, after: { id: "m1", text: "?" } }]);
  const ownerMuddle = await ownerPhone.push([{ collection: "muddle", id: "m1", base: 0, after: { id: "m1", text: "!" } }]);
  check(
    "rules: rules that can't be read lock the collection to the owner, and say what is wrong with them, rather than letting everyone in",
    muddled?.[0]?.denied === true && /rules can't be read/.test(muddled[0].error ?? "") && /"editors" or "author" or "owner", not "everyone"/.test(muddled[0].error ?? "") && ownerMuddle?.[0]?.ok,
    JSON.stringify({ muddled, ownerMuddle }),
  );

  // A role changed while connected: the member's connections close, and the next one has the new role.
  const closed = new Promise((done) => {
    raePhone.onClose((code) => done(code));
    setTimeout(() => done("still open"), 4000);
  });
  const promoted = await owner.call("/auth/spaces/club/role", { user: id("Rae"), role: "editor" });
  const code = await closed;
  const raeAgain = await device(base, "club", rae.cookie);
  await raeAgain.hello(0);
  const now = await raeAgain.push([{ collection: "books", id: "persuasion", base: 0, after: { id: "persuasion", title: "Persuasion" } }]);
  check("roles: made an editor, a reader's open connection closes, and the one it opens next can change the space", promoted.status === 200 && code === 4403 && told(raeAgain)?.role === "editor" && now?.[0]?.ok, JSON.stringify({ promoted, code, role: told(raeAgain)?.role, now }));

  // Made a reader, an editor's agent key stops working with the role.
  const mcp = (key) => fetch(`${base}/s/club/mcp/reading-list-agents`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } } }) }).then((r) => r.status);
  const before = await mcp(edKey.body?.key);
  await owner.call("/auth/spaces/club/role", { user: id("Ed"), role: "reader" });
  const afterDemotion = await mcp(edKey.body?.key);
  check("roles: an editor made a reader loses the agent keys they made for the space", before !== 401 && afterDemotion === 401, JSON.stringify({ before, afterDemotion }));

  // After a restart the rules and who added what still hold, before any app is opened again.
  for (const d of [ownerPhone, edPhone, raeAgain]) d.close();
  base = await restart();
  const later = await device(base, "club", rae.cookie);
  await later.hello(0);
  const head = later.changes().findLast((c) => c.collection === "ledger-entries" && c.id === "o1")?.seq;
  const stillRefused = await later.push([{ collection: "ledger-entries", id: "o1", base: head, after: { id: "o1", text: "Rae was here" } }]);
  const stillOwners = await later.push([{ collection: "notices", id: "n2", base: 0, after: { id: "n2", text: "Hello" } }]);
  later.close();
  check("rules: after the server starts again, the rules and who added each record still hold", stillRefused?.[0]?.denied === true && /Owner added this/.test(stillRefused[0].error ?? "") && stillOwners?.[0]?.denied === true, JSON.stringify({ head, stillRefused, stillOwners }));
  return base;
}
