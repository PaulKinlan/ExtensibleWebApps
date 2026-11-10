// Signing an MCP client in to a space's MCP server with OAuth, as MCP's
// authorization spec has it, so a member can connect an agent (Claude Code,
// any MCP client) without copying a key. The member says yes on a page of
// this site, and the client gets an agent key (agent-keys.ts) as its access
// token: the same key a member can make on /account/, listed there under the
// client's name and revoked there. So nothing about what an agent may do
// changes; only how its key reaches it.
//
//   GET  /.well-known/oauth-protected-resource/s/<space>/mcp/<plugin>
//                                    which server signs agents in for that MCP address (RFC 9728);
//                                    the MCP server's 401 points here (src/server/mcp.ts)
//   GET  /.well-known/oauth-authorization-server
//                                    this server's endpoints (RFC 8414)
//   POST /auth/mcp/register          a client says who it is and where to send people back (RFC 7591)
//   GET  /auth/mcp/authorize         the page where a signed-in member says yes or no
//   POST /auth/mcp/authorize         their answer: back to the client, with a code if it was yes
//   POST /auth/mcp/token             the client trades the code (and its PKCE verifier) for the key,
//                                    or its refresh token for a new key when the last one runs out
//   GET  /auth/mcp/signin.js         the sign-in page's one script: a passkey, right there
//
// Clients are public (no secret) and must use PKCE with S256, and the
// `resource` they ask for must be an MCP address on this site, which names the
// space. Nothing is kept for a registration: the client id carries the
// client's name and addresses, so registering can't fill the server's files.
// A code lives a minute and works once; only its hash is kept.
//
// The key a client gets lasts an hour (ACCESS_MS), and comes with a refresh
// token that lasts a month (REFRESH_MS). Trading the refresh token gives a new
// key in the old one's place (agent-keys.ts renew: the same entry on
// /account/) and a new refresh token; the old one is spent. A spent refresh
// token used again means someone copied it, so the key it was for is revoked.
// Revoking the key on /account/, or leaving the space, ends the refreshing too.
//
// Someone signed out who is asked to connect an agent signs in on that same
// page: with a passkey (signin.js), or with another site, which sends them back
// to the page (accounts.ts keeps where, `return`). Making a new account is on
// /account/, in another tab; the page notices the sign-in and carries on.

import type { Files } from "../../seams/index.ts";
import { mcpAddress } from "../mcp.ts";
import { bodyOf } from "./accounts.ts";
import type { agentKeys } from "./agent-keys.ts";
import { b64url, unb64url } from "./webauthn.ts";

/** How long a code from the consent page lasts. */
const CODE_MS = 60_000;
/** How long a signed-in client's key works before it trades its refresh token for a new one. */
export const ACCESS_MS = 3_600_000;
/** How long a refresh token lasts unused: each trade gives a new one, so a client in use stays connected. */
export const REFRESH_MS = 30 * 24 * 3_600_000;
const MAX_BODY = 16 * 1024;
const MAX_URIS = 5;
/** Schemes a client may never be sent back to. */
const UNSAFE_SCHEME = /^(javascript|data|file|blob|vbscript|about|ws|wss|ftp|http):$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A client, as its id carries it. */
interface Client {
  name: string;
  uris: string[];
}

/** What is kept for a code, under its hash. */
interface Code {
  user: string;
  space: string;
  plugin: string;
  resource: string;
  client: string;
  name: string;
  redirect: string;
  challenge: string;
  expires: number;
}

/** What is kept for a refresh token, under its hash. */
interface Refresh {
  user: string;
  space: string;
  plugin: string;
  resource: string;
  client: string;
  /** The agent key's id it renews. */
  key: string;
  expires: number;
  /** Traded already: kept until it would have expired, so using it again is noticed. */
  spent?: boolean;
}

/** Another site someone can sign in with (providers.ts), and what it asks them first, if anything. */
export interface SignInSite {
  id: string;
  name: string;
  ask?: { name: string; label: string; placeholder?: string };
}

/** What the sign-in asks of the accounts. */
export interface McpOAuthAccounts {
  /** Who the request's session is signed in as. */
  user(request: Request): Promise<{ id: string; name: string } | null>;
  isMember(space: string, user: string): Promise<boolean>;
  keys: ReturnType<typeof agentKeys>;
  /** Runs a change one at a time with the accounts' others. */
  serial<T>(task: () => Promise<T>): Promise<T>;
  /** The other sites someone can sign in with, to offer on the page. */
  providers?: () => SignInSite[];
}

const hash = async (text: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** For clients that run in a browser on another site (an inspector): the public parts answer anyone. */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A redirect address a client may register: https, http to this machine (RFC 8252), or an app's own scheme. */
function redirectOk(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 512) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !UNSAFE_SCHEME.test(url.protocol);
}

const clientId = (client: Client) => `c_${b64url(new TextEncoder().encode(JSON.stringify({ n: client.name, r: client.uris })))}`;

/** The client an id carries, or null if it isn't one this server gave. */
function clientOf(id: unknown): Client | null {
  if (typeof id !== "string" || !id.startsWith("c_") || id.length > 4096) return null;
  try {
    const { n, r } = JSON.parse(new TextDecoder().decode(unb64url(id.slice(2))));
    if (typeof n !== "string" || !Array.isArray(r) || !r.length || r.length > MAX_URIS || !r.every(redirectOk)) return null;
    return { name: n.slice(0, 64), uris: r };
  } catch {
    return null;
  }
}

/** The MCP address a `resource` names, if it is one on this site. */
function resourceOf(resource: unknown, origin: string): { space: string; plugin: string; href: string } | null {
  if (typeof resource !== "string") return null;
  try {
    const url = new URL(resource);
    const at = url.origin === origin && !url.search && !url.hash ? mcpAddress(url) : undefined;
    return at ? { ...at, href: `${origin}/s/${at.space}/mcp/${at.plugin}` } : null;
  } catch {
    return null;
  }
}

/** What form-action needs to allow, so the browser follows the answer's redirect to the client. */
const formTarget = (uri: string) => {
  const url = new URL(uri);
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : url.protocol;
};

/** A page of the sign-in: no script, its own small style, and only this site's forms. */
function page(title: string, body: string, status = 200, formAction = "'self'", script?: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #fafaf9; --fg: #1c1917; --muted: #57534e; --line: #e7e5e4; --accent: #2563eb; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --accent: #60a5fa; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 32rem; margin: 10vh auto; padding: 0 16px; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; }
p, li { color: var(--muted); }
strong { color: var(--fg); }
.buttons { display: flex; gap: 12px; margin-top: 1.5rem; flex-wrap: wrap; }
button, a.button, input { font: inherit; padding: 10px 18px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; text-decoration: none; }
button[value="allow"], a.primary, #passkey { background: var(--accent); border-color: var(--accent); color: #fff; }
code { font-size: 0.9em; }
a { color: var(--accent); }
form.site { display: flex; gap: 8px; flex-wrap: wrap; margin: 0; }
input { cursor: text; min-width: 12rem; }
#said:empty { display: none; }
</style></head>
<body><main>${body}</main>${script ? `<script src="${escape(script)}" defer></script>` : ""}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline';${script ? " script-src 'self'; connect-src 'self';" : ""} form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

const problem = (text: string, status = 400) => page("Can't connect the agent", `<h1>Can't connect the agent</h1><p>${escape(text)}</p>`, status);

/** Sends the person back to the client with an answer. */
const back = (uri: string, params: Record<string, string | undefined>) => {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return new Response(null, { status: 303, headers: { location: url.href, "cache-control": "no-store" } });
};

export function mcpOAuth(files: Files, accounts: McpOAuthAccounts) {
  const read = async <T>(path: string): Promise<T | null> => {
    const text = await files.readText(path);
    return text ? (JSON.parse(text) as T) : null;
  };

  /** Codes nobody traded in: cleared now and then. */
  let swept = 0;
  const sweep = async () => {
    if (Date.now() - swept < 10 * 60_000) return;
    swept = Date.now();
    for (const path of [...(await files.list("mcp-oauth/codes/")), ...(await files.list("mcp-oauth/refresh/"))]) if (((await read<{ expires: number }>(path))?.expires ?? 0) < Date.now()) await files.remove(path);
  };

  /** An authorize request's parameters, checked: what the page and the answer both need. */
  type Asked = { client: Client; clientId: string; redirect: string; state?: string; challenge: string; resource: { space: string; plugin: string; href: string } };
  function check(params: URLSearchParams, origin: string): { asked: Asked } | { page: Response } | { redirect: Response } {
    const id = params.get("client_id");
    const client = clientOf(id);
    if (!client) return { page: problem("The agent didn't say who it is in a way this site understands. Connect it again.") };
    const redirect = params.get("redirect_uri") ?? (client.uris.length === 1 ? client.uris[0] : "");
    if (!client.uris.includes(redirect) || (new URL(redirect).origin === origin && new URL(redirect).pathname.startsWith("/s/")))
      return { page: problem("The agent asked to send you somewhere it isn't allowed to use as a callback. Connect it again.") };
    // From here on, a problem goes back to the agent.
    const state = params.get("state") ?? undefined;
    const fail = (error: string, description: string) => ({ redirect: back(redirect, { error, error_description: description, state, iss: origin }) });
    if (params.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code");
    const challenge = params.get("code_challenge") ?? "";
    if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request", "PKCE with S256 is required");
    const resource = resourceOf(params.get("resource"), origin);
    if (!resource) return fail("invalid_target", "`resource` must be a space's MCP address on this site, /s/<space>/mcp/<plugin>");
    return { asked: { client, clientId: id!, redirect, state, challenge, resource } };
  }

  /** The consent page, for a signed-in member. */
  function consent(asked: Asked, user: { name: string }, params: URLSearchParams, origin: string): Response {
    const host = /^https?:$/.test(new URL(asked.redirect).protocol) ? new URL(asked.redirect).host : new URL(asked.redirect).protocol.slice(0, -1);
    const name = asked.client.name || host;
    const hidden = ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "resource", "scope"]
      .flatMap((k) => (params.has(k) ? [`<input type="hidden" name="${k}" value="${escape(params.get(k)!)}">`] : []))
      .join("\n");
    return page(
      `Connect ${name}?`,
      `<h1>Connect <strong>${escape(name)}</strong> to the space <strong>${escape(asked.resource.space)}</strong>?</h1>
<p>Signed in as <strong>${escape(user.name)}</strong>. The agent will act as you, in this space only, through <code>${escape(asked.resource.plugin)}</code>: it can use that plugin's tools and nothing else, and you review every change it asks to make to data the plugin doesn't own.</p>
<p>It gets an agent key, which you can see and revoke on <a href="${escape(origin)}/account/">your account</a>. After you answer, you go back to <strong>${escape(host)}</strong>.</p>
<form method="post" action="/auth/mcp/authorize">
${hidden}
<div class="buttons"><button name="answer" value="allow">Connect</button><button name="answer" value="deny">Don't connect</button></div>
</form>`,
      200,
      `'self' ${formTarget(asked.redirect)}`,
    );
  }

  /**
   * The page for someone signed out: sign in right here (a passkey, or another site that sends them back), or
   * make an account on /account/ in another tab; signed in either way, the page becomes the consent page.
   */
  function signInPage(asked: Asked, params: URLSearchParams): Response {
    const query = new URLSearchParams([...params].filter(([k]) => k !== "answer"));
    const again = `/auth/mcp/authorize?${query}`;
    const sites = (accounts.providers?.() ?? [])
      .map(
        (site) => `<form class="site" method="get" action="/auth/oauth/${escape(site.id)}/start"><input type="hidden" name="return" value="${escape(again)}">${
          site.ask ? `<input name="${escape(site.ask.name)}" aria-label="${escape(site.ask.label)}" placeholder="${escape(site.ask.placeholder ?? site.ask.label)}" required>` : ""
        }<button>Sign in with ${escape(site.name)}</button></form>`,
      )
      .join("\n");
    return page(
      "Sign in to connect your agent",
      `<h1>Sign in to connect your agent</h1><p>An agent wants to use the space <strong>${escape(asked.resource.space)}</strong> as you. Sign in, and this page asks you whether to connect it.</p>
<div class="buttons"><button id="passkey" type="button" data-again="${escape(again)}">Sign in with a passkey</button></div>
${sites ? `<div class="buttons">${sites}</div>` : ""}
<p id="said" role="status"></p>
<p>New here? <a href="/account/" target="_blank" rel="noopener">Make an account</a> in another tab. This page carries on by itself once you're signed in, or <a href="${escape(again)}">look again</a>.</p>`,
      200,
      // Another site's sign-in starts here and redirects there, and Chromium holds a form's redirects to form-action too.
      sites ? "'self' https: http:" : "'self'",
      "/auth/mcp/signin.js",
    );
  }

  async function authorize(request: Request, url: URL): Promise<Response> {
    const posted = request.method === "POST";
    let params = url.searchParams;
    if (posted) {
      // Only this site's own consent page answers (a form on another site can't).
      if (request.headers.get("origin") !== url.origin) return problem("Answer from this site's own page.", 403);
      const text = await bodyOf(request, MAX_BODY);
      if (text === null) return problem("That's too much.", 413);
      params = new URLSearchParams(text);
    }
    const checked = check(params, url.origin);
    if ("page" in checked) return checked.page;
    if ("redirect" in checked) return checked.redirect;
    const { asked } = checked;
    const user = await accounts.user(request);
    if (!user) return signInPage(asked, params);
    if (!(await accounts.isMember(asked.resource.space, user.id))) return problem(`You aren't in the space ${asked.resource.space}, so an agent can't use it as you.`, 403);
    if (!posted) return consent(asked, user, params, url.origin);
    if (params.get("answer") !== "allow") return back(asked.redirect, { error: "access_denied", error_description: "The member didn't connect the agent", state: asked.state, iss: url.origin });
    await sweep();
    const code = random(32);
    const kept: Code = {
      user: user.id,
      space: asked.resource.space,
      plugin: asked.resource.plugin,
      resource: asked.resource.href,
      client: asked.clientId,
      name: asked.client.name || new URL(asked.redirect).host || "MCP client",
      redirect: asked.redirect,
      challenge: asked.challenge,
      expires: Date.now() + CODE_MS,
    };
    await files.write(`mcp-oauth/codes/${await hash(code)}.json`, JSON.stringify(kept));
    return back(asked.redirect, { code, state: asked.state, iss: url.origin });
  }

  async function token(request: Request, url: URL): Promise<Response> {
    const text = await bodyOf(request, MAX_BODY);
    if (text === null) return oauthError("invalid_request", "Too big", 413);
    // The spec's form, though some clients send JSON.
    let params = new URLSearchParams(text);
    if (/application\/json/i.test(request.headers.get("content-type") ?? "")) {
      params = new URLSearchParams();
      try {
        for (const [k, v] of Object.entries((JSON.parse(text) ?? {}) as Record<string, unknown>)) params.set(k, String(v));
      } catch {
        return oauthError("invalid_request", "Not JSON");
      }
    }
    if (params.get("grant_type") === "refresh_token") return refresh(params, url);
    if (params.get("grant_type") !== "authorization_code") return oauthError("unsupported_grant_type", "Only authorization_code and refresh_token");
    const code = params.get("code") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return oauthError("invalid_grant", "That isn't a code this site gave");
    return accounts.serial(async () => {
      const path = `mcp-oauth/codes/${await hash(code)}.json`;
      const kept = await read<Code>(path);
      // A code works once, right or wrong.
      if (kept) await files.remove(path);
      if (!kept || kept.expires < Date.now()) return oauthError("invalid_grant", "That code has expired or was used: connect again");
      if (params.get("client_id") !== kept.client) return oauthError("invalid_grant", "That code is for another client");
      if (params.has("redirect_uri") && params.get("redirect_uri") !== kept.redirect) return oauthError("invalid_grant", "redirect_uri isn't the one the code was given for");
      if (params.has("resource") && resourceOf(params.get("resource"), url.origin)?.href !== kept.resource) return oauthError("invalid_target", "That code is for another MCP address");
      const verifier = params.get("code_verifier") ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || (await hash(verifier)) !== kept.challenge) return oauthError("invalid_grant", "code_verifier doesn't match");
      // Connecting the same client to the same address again replaces the key it had, rather than piling them up.
      for (const old of await accounts.keys.list(kept.user)) if (old.client === kept.client && old.space === kept.space && old.plugin === kept.plugin) await accounts.keys.revoke(kept.user, old.id);
      // The key reaches only the door the member said yes to.
      const made = await accounts.keys.make(kept.user, kept.space, kept.name, { plugin: kept.plugin, client: kept.client, expires: Date.now() + ACCESS_MS });
      if ("error" in made) return oauthError("invalid_grant", made.error);
      return granted(made.key, { user: kept.user, space: kept.space, plugin: kept.plugin, resource: kept.resource, client: kept.client, key: made.made.id });
    });
  }

  /** The token endpoint's answer: the key, how long it lasts, and a new refresh token kept for it. */
  async function granted(key: string, grant: Omit<Refresh, "expires" | "spent">): Promise<Response> {
    const token = random(32);
    await files.write(`mcp-oauth/refresh/${await hash(token)}.json`, JSON.stringify({ ...grant, expires: Date.now() + REFRESH_MS } satisfies Refresh));
    return json({ access_token: key, token_type: "Bearer", expires_in: ACCESS_MS / 1000, refresh_token: token, scope: "mcp" });
  }

  /** A client trades its refresh token for a new key, in the old one's place, and a new refresh token. */
  async function refresh(params: URLSearchParams, url: URL): Promise<Response> {
    const token = params.get("refresh_token") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return oauthError("invalid_grant", "That isn't a refresh token this site gave");
    return accounts.serial(async () => {
      await sweep();
      const path = `mcp-oauth/refresh/${await hash(token)}.json`;
      const kept = await read<Refresh>(path);
      if (!kept || kept.expires < Date.now()) return oauthError("invalid_grant", "That refresh token has expired: connect again");
      if (params.get("client_id") !== kept.client) return oauthError("invalid_grant", "That refresh token is for another client");
      // Used twice: one of the two is a copy. The key is ended, and the member connects the agent again.
      if (kept.spent) {
        await files.remove(path);
        await accounts.keys.revoke(kept.user, kept.key);
        return oauthError("invalid_grant", "That refresh token was used already, so the key is revoked: connect again");
      }
      if (params.has("resource") && resourceOf(params.get("resource"), url.origin)?.href !== kept.resource) return oauthError("invalid_target", "That refresh token is for another MCP address");
      if (!(await accounts.isMember(kept.space, kept.user))) {
        await files.remove(path);
        return oauthError("invalid_grant", `The member who connected it isn't in the space ${kept.space} any more`);
      }
      const renewed = await accounts.keys.renew(kept.user, kept.key, Date.now() + ACCESS_MS);
      // Revoked on /account/ (or replaced by connecting again): the refreshing ends with it.
      if (!renewed) {
        await files.remove(path);
        return oauthError("invalid_grant", "That key was revoked: connect again");
      }
      await files.write(path, JSON.stringify({ ...kept, spent: true } satisfies Refresh));
      const { expires: _expires, spent: _spent, ...grant } = kept;
      return granted(renewed.key, grant);
    });
  }

  function register(text: string): Response {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      return oauthError("invalid_client_metadata", "JSON only");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return oauthError("invalid_client_metadata", "A JSON object, please");
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > MAX_URIS) return oauthError("invalid_redirect_uri", `Give one to ${MAX_URIS} redirect_uris`);
    if (!uris.every(redirectOk)) return oauthError("invalid_redirect_uri", "Each redirect_uri must be https, http to localhost, or an app's own scheme");
    const method = body.token_endpoint_auth_method ?? "none";
    if (method !== "none") return oauthError("invalid_client_metadata", "Clients here are public: token_endpoint_auth_method must be none, with PKCE");
    const client: Client = { name: typeof body.client_name === "string" ? body.client_name.trim().slice(0, 64) : "", uris: uris as string[] };
    return json(
      {
        client_id: clientId(client),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: client.name,
        redirect_uris: client.uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  }

  return {
    /** Answers a request that is part of the sign-in, or gives undefined for any other. */
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      const { pathname } = url;
      const ours = pathname.startsWith("/.well-known/oauth-") || pathname.startsWith("/auth/mcp/");
      if (!ours) return undefined;
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      const protectedResource = /^\/\.well-known\/oauth-protected-resource(\/.*)?$/.exec(pathname);
      if (protectedResource && request.method === "GET") {
        const resource = resourceOf(`${url.origin}${protectedResource[1] ?? ""}`, url.origin);
        if (!resource) return oauthError("invalid_target", "Not an MCP address on this site", 404);
        return json({ resource: resource.href, authorization_servers: [url.origin], bearer_methods_supported: ["header"], scopes_supported: ["mcp"], resource_name: `${resource.plugin} in ${resource.space}` });
      }
      // The issuer is the site itself, so its metadata is at the well-known path with nothing after it.
      if (/^\/\.well-known\/oauth-authorization-server$/.test(pathname) && request.method === "GET")
        return json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/auth/mcp/authorize`,
          token_endpoint: `${url.origin}/auth/mcp/token`,
          registration_endpoint: `${url.origin}/auth/mcp/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["mcp"],
          authorization_response_iss_parameter_supported: true,
        });
      if (pathname === "/auth/mcp/authorize" && (request.method === "GET" || request.method === "POST")) return authorize(request, url);
      if (pathname === "/auth/mcp/token" && request.method === "POST") return token(request, url);
      if (pathname === "/auth/mcp/signin.js" && request.method === "GET")
        return new Response(SIGN_IN_SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
      if (pathname === "/auth/mcp/register" && request.method === "POST") {
        const text = await bodyOf(request, MAX_BODY);
        return text === null ? oauthError("invalid_client_metadata", "Too big", 413) : register(text);
      }
      return oauthError("invalid_request", "Not part of the sign-in", 404);
    },
  };
}

/**
 * The sign-in page's script (signInPage): signs in with a passkey right there, and, signed in in another tab
 * instead (a new account on /account/), notices and carries on, so the page turns into the consent page by itself.
 */
const SIGN_IN_SCRIPT = `// Signing in where an agent asks to connect (src/server/auth/mcp-oauth.ts).
const button = document.getElementById("passkey");
const again = button.dataset.again;
const said = (text) => (document.getElementById("said").textContent = text);
const post = async (path, body) => {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "The server answered " + res.status);
  return data;
};
if (!window.PublicKeyCredential?.parseRequestOptionsFromJSON) button.hidden = true;
button.addEventListener("click", async () => {
  said("");
  try {
    const options = await post("/auth/signin/options", {});
    const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
    await post("/auth/signin", credential.toJSON());
    location.replace(again);
  } catch (error) {
    said(error.name === "NotAllowedError" ? "No passkey was used." : error.message);
  }
});
// Signed in in another tab: carry on here. Asked every few seconds for a quarter of an hour, and on coming back to the tab.
const until = Date.now() + 15 * 60_000;
const look = async () => {
  if (Date.now() > until) return clearInterval(timer);
  const res = await fetch("/auth/me", { cache: "no-store" }).catch(() => null);
  if (res && res.ok) {
    clearInterval(timer);
    location.replace(again);
  }
};
const timer = setInterval(look, 3000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && look());
`;
