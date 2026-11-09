// Agent keys, on /account/: a key lets an agent outside the browser (Claude
// Code, any MCP client) use the apps in one of your spaces, as you, through
// the space's MCP server (src/server/auth/agent-keys.ts, docs/guide/outside-agents.md).
// Make one per agent, name it after the agent, and revoke it when you stop using it.
// The page shows a key once, as it is made, with what to paste into the agent.

const $ = (id) => document.getElementById(id);

async function call(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `The server answered ${res.status}`);
  return data;
}

const when = (at) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

async function show() {
  if ($("in").hidden) return;
  const [{ keys = [] }, { spaces = [] }] = await Promise.all([call("/auth/keys").catch(() => ({})), call("/auth/spaces").catch(() => ({}))]);
  $("key-space").replaceChildren(...spaces.map(({ name }) => Object.assign(document.createElement("option"), { value: name, textContent: name })));
  $("new-key").hidden = !spaces.length;
  $("keys").replaceChildren(
    ...keys.map((key) => {
      const li = document.createElement("li");
      li.append(Object.assign(document.createElement("strong"), { textContent: key.name }), ` for ${key.space}, made ${when(key.created)}${key.used ? `, last used ${when(key.used)}` : ", not used yet"} `);
      const revoke = Object.assign(document.createElement("button"), { type: "button", textContent: "Revoke" });
      revoke.addEventListener("click", async () => {
        await call("/auth/keys/revoke", { id: key.id }).catch((error) => ($("status").textContent = error.message));
        $("key-made").hidden = true;
        show();
      });
      li.append(revoke);
      return li;
    }),
  );
  if (!keys.length) $("keys").append(Object.assign(document.createElement("li"), { textContent: spaces.length ? "None yet." : "Make a space first: a key is for one space." }));
}

$("new-key").addEventListener("submit", async (event) => {
  event.preventDefault();
  const space = $("key-space").value;
  try {
    const { key } = await call("/auth/keys", { space, name: $("key-name").value.trim() });
    const url = new URL(`/s/${space}/mcp/reading-list-agents`, location.href).href;
    $("key-value").value = key;
    $("key-command").value = `claude mcp add --transport http reading-list ${url} --header "Authorization: Bearer ${key}"`;
    $("key-made").hidden = false;
    event.target.reset();
  } catch (error) {
    $("status").textContent = error.message;
  }
  show();
});

// The page shows #in once it knows you're signed in, and again after anything changes.
new MutationObserver(() => show()).observe($("in"), { attributes: true, attributeFilter: ["hidden"] });
show();
