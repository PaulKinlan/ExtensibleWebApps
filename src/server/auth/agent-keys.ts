// Agent keys: how an agent outside the browser (Claude Code, any MCP client)
// reaches a space's MCP server (std/outside/module.ts) as one of its members.
// A member makes a key for one space on /account/, names it after the agent
// it is for, and pastes it into the agent, which sends it as
// `Authorization: Bearer <key>`. The agent then acts as that member, and only
// in that space; leaving the space, or revoking the key, ends it at once.
//
//   GET  /auth/keys                          your keys: id, name, space, when made and last used (never the key)
//   POST /auth/keys            { space, name } makes one; the answer is the only time the key is shown
//   POST /auth/keys/revoke     { id }          ends one
//
// As with sessions, only a key's hash is kept, so the files can't be used as keys.

import type { Files } from "../../seams/index.ts";
import { b64url } from "./webauthn.ts";

/** A key as its member sees it in the list. */
export interface AgentKey {
  id: string;
  name: string;
  space: string;
  created: number;
  used?: number;
  /** For a key an MCP client got by signing in (mcp-oauth.ts): the one door it may use, and the client it was given to. */
  plugin?: string;
  client?: string;
}

/** What is kept for a key, under its hash. */
interface Kept extends AgentKey {
  user: string;
}

/** A key as it is given out: recognisable in a config file, and long enough that it can't be guessed. */
const PREFIX = "ewa_";
const KEY = /^ewa_[A-Za-z0-9_-]{43}$/;
const MAX_KEYS = 20;
/** How often a key's "last used" is written: not on every call. */
const USED_EVERY_MS = 60_000;

const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const hash = async (text: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

/** What the keys ask of the accounts. */
export interface KeyAccounts {
  /** Whether a user is a member of a space. */
  isMember(space: string, user: string): Promise<boolean>;
}

export function agentKeys(files: Files, accounts: KeyAccounts) {
  const read = async <T>(path: string): Promise<T | null> => {
    const text = await files.readText(path);
    return text ? (JSON.parse(text) as T) : null;
  };
  /** A user's keys, by id: the index the list reads, pointing at each key's hash. */
  const indexOf = async (user: string) => (await read<Record<string, string>>(`agent-keys/users/${user}.json`)) ?? {};

  return {
    async list(user: string): Promise<AgentKey[]> {
      const index = await indexOf(user);
      const keys = await Promise.all(Object.values(index).map((h) => read<Kept>(`agent-keys/${h}.json`)));
      return keys.flatMap((k) => (k ? [{ id: k.id, name: k.name, space: k.space, created: k.created, ...(k.used ? { used: k.used } : {}), ...(k.plugin ? { plugin: k.plugin } : {}), ...(k.client ? { client: k.client } : {}) }] : [])).sort((a, b) => a.created - b.created);
    },

    async make(user: string, space: string, name: string, only: { plugin?: string; client?: string } = {}): Promise<{ key: string; made: AgentKey } | { error: string; status: number }> {
      if (!(await accounts.isMember(space, user))) return { error: "You aren't in that space", status: 403 };
      const label = name.trim().slice(0, 64);
      if (!label) return { error: "Name the key after the agent it's for", status: 400 };
      const index = await indexOf(user);
      if (Object.keys(index).length >= MAX_KEYS) return { error: `You have ${MAX_KEYS} keys: revoke one first`, status: 400 };
      const key = PREFIX + random(32);
      const kept: Kept = { id: random(9), name: label, space, user, created: Date.now(), ...(only.plugin ? { plugin: only.plugin } : {}), ...(only.client ? { client: only.client } : {}) };
      const h = await hash(key);
      await files.write(`agent-keys/${h}.json`, JSON.stringify(kept));
      await files.write(`agent-keys/users/${user}.json`, JSON.stringify({ ...index, [kept.id]: h }));
      const { user: _user, ...made } = kept;
      return { key, made };
    },

    async revoke(user: string, id: string): Promise<boolean> {
      const index = await indexOf(user);
      const h = index[id];
      if (!h) return false;
      await files.remove(`agent-keys/${h}.json`);
      delete index[id];
      await files.write(`agent-keys/users/${user}.json`, JSON.stringify(index));
      return true;
    },

    /**
     * The member an `Authorization: Bearer <key>` header is for, if the key is for this space (and, for a key
     * limited to one door, this plugin's) and they're still in it.
     */
    async member(authorization: string | null, space: string, plugin?: string): Promise<{ user: string; key: string } | null> {
      const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
      if (!token || !KEY.test(token)) return null;
      const h = await hash(token);
      const kept = await read<Kept>(`agent-keys/${h}.json`);
      if (!kept || kept.space !== space || (kept.plugin && kept.plugin !== plugin) || !(await accounts.isMember(space, kept.user))) return null;
      if (!kept.used || Date.now() - kept.used > USED_EVERY_MS) await files.write(`agent-keys/${h}.json`, JSON.stringify({ ...kept, used: Date.now() }));
      return { user: kept.user, key: kept.id };
    },
  };
}
