// What a person added follows them between devices (src/server/auth/follow.ts),
// the same on every host: the account keeps each item's latest value under a
// number, a device that says the last number it saw gets only what is newer, a
// removed item comes as a mark, one person never sees another's, and what is
// too big or isn't an item is refused in words a person can act on.

/** @param {string} base @param {(what: string, ok: unknown, detail?: string) => void} check @param {{ cookie: string }} owner @param {{ cookie: string }} stranger */
export async function followChecks(base, check, owner, stranger) {
  const get = async (who, since = 0) => {
    const res = await fetch(`${base}/auth/follow?since=${since}`, { headers: who ? { cookie: who.cookie } : {} });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const post = async (who, changes, origin = base) => {
    const res = await fetch(`${base}/auth/follow`, { method: "POST", headers: { origin, "content-type": "application/json", ...(who && { cookie: who.cookie }) }, body: JSON.stringify({ changes }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const out = await get(null);
  const elsewhere = await post(owner, [{ key: "llm:prefer", h: "a", value: "x" }], "https://elsewhere.example");
  check("follow: signed out there is nothing to follow, and another site can't send changes", out.status === 401 && elsewhere.status === 403, `${out.status} ${elsewhere.status}`);

  const plugin = 'export const manifest = { id: "note", name: "Note", permissions: [] };\nexport default () => {};';
  const first = await post(owner, [
    { key: "file:demos/trip/note.js", h: "h1", value: { t: plugin } },
    { key: "on:demos/trip/note", h: "1", value: true },
    { key: "move:demos/trip|note|main", h: "m1", value: { at: "footer", put: "prepend" } },
  ]);
  const all = await get(owner);
  const file = all.body.items?.find((i) => i.key === "file:demos/trip/note.js");
  check("follow: what one device sends, another signed in as the same person gets, each change with the next number", first.status === 200 && first.body.version === 3 && all.body.version === 3 && all.body.items?.length === 3 && file?.value?.t === plugin && file.h === "h1", JSON.stringify([first.body, all.body.items?.map((i) => [i.key, i.v])]));

  const same = await post(owner, [{ key: "on:demos/trip/note", h: "1", value: true }]);
  const changed = await post(owner, [{ key: "move:demos/trip|note|main", h: "m2", value: { at: "header", put: "after" } }, { key: "on:demos/trip/note", gone: true }]);
  const newer = await get(owner, 3);
  check(
    "follow: an item sent again unchanged takes no number; a device gets only what is newer than it has, and a removed item as a mark",
    same.body.version === 3 && !same.body.saved?.length && changed.body.version === 5 && newer.body.items?.length === 2 && newer.body.items.some((i) => i.key === "on:demos/trip/note" && i.gone && i.value === undefined) && newer.body.items.some((i) => i.key.startsWith("move:") && i.value?.at === "header"),
    JSON.stringify([same.body, newer.body.items]),
  );
  const fresh = await get(owner);
  check("follow: a device that has seen nothing isn't told about what was removed", fresh.body.items?.length === 2 && !fresh.body.items.some((i) => i.gone), JSON.stringify(fresh.body.items?.map((i) => i.key)));

  const theirs = await get(stranger);
  check("follow: one person's account never gives another's", theirs.status === 200 && theirs.body.version === 0 && theirs.body.items?.length === 0, JSON.stringify(theirs.body));

  const big = await post(owner, [{ key: "file:demos/trip/big.js", h: "b", value: { t: "x".repeat(300 * 1024) } }]);
  const odd = await post(owner, [{ key: "../secrets.json", h: "s", value: "k" }]);
  const after = await get(owner);
  check(
    "follow: a file too big for the account, or something that isn't one of a person's additions, is refused saying why, and nothing changes",
    big.status === 413 && /at most 256 KB/.test(big.body.error ?? "") && /stays on this device/.test(big.body.error ?? "") && odd.status === 400 && /isn't the name of something an account keeps/.test(odd.body.error ?? "") && after.body.version === 5,
    JSON.stringify([big.body, odd.body, after.body.version]),
  );
}
