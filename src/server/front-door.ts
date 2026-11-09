// The server's front door: what happens to a request before any host does
// anything with it. Node (serve.ts) and Cloudflare (cloudflare/worker.ts) each
// ask it, then do only their own I/O: sockets and worker threads, or Durable
// Objects and static assets. So who may join a space, which origin may open
// its socket and when a space's public routes answer is written once, and a
// third host gets it by calling this.
//
//   /auth/…              → auth     the accounts answer (src/server/auth/accounts.ts)
//   /.well-known/oauth-… → auth     where an MCP client signs in (src/server/auth/mcp-oauth.ts)
//   /s/<space>/kernel    → join     a member's WebSocket to the space's kernel, from this site's pages
//   /s/<space>/<path>    → route    one of the space's server plugins may answer (src/server/routes.ts);
//                                   if none does, `unrouted` says what then
//   /feed-reader         → feed     reads one public feed for this site's pages (src/server/feed-reader.ts)
//   anything else        → asset    the site's files, for GET and HEAD
//
// Anything the door doesn't let through is `refuse`, with the status to send.

import { FEED_READER } from "./feed-reader.ts";
import { spaceRoute } from "./routes.ts";

/** A space's name, as the accounts make them. */
export const SPACE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** What the door asks of the accounts. */
export interface Accounts {
  /** Whether a space by this name exists. */
  exists(space: string): Promise<boolean>;
  /** Which member of a space the session in a cookie header is, or null if it's no member's. */
  member(cookie: string, space: string): Promise<string | null>;
}

/** The parts of a request the door reads. */
export interface Knock {
  method: string;
  /** The address as the client reached this host: its host is what a browser's Origin must match. */
  url: URL;
  /** The Origin header, or null when there's none (a client that isn't a browser sends none). */
  origin: string | null;
  cookie: string;
  /** Whether it asks to become a WebSocket. */
  upgrade: boolean;
}

export type Decision =
  | { door: "auth" }
  | { door: "join"; space: string; member: string }
  | { door: "route"; space: string; path: string }
  | { door: "feed" }
  | { door: "asset" }
  | { door: "refuse"; status: number; text: string };

const refuse = (status: number, text: string): Decision => ({ door: "refuse", status, text });

/** Whether a browser's Origin, if it sent one, is this host. */
export function sameOrigin(origin: string | null, url: URL): boolean {
  if (origin === null) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

/** Where a request goes. */
export async function frontDoor(knock: Knock, accounts: Accounts): Promise<Decision> {
  const { pathname } = knock.url;
  // An MCP client finding where to sign in (src/server/auth/mcp-oauth.ts) is the accounts' too.
  if (pathname.startsWith("/auth/") || /^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server)(\/|$)/.test(pathname)) return { door: "auth" };

  // Reading a feed needs no space and no sign-in: it is how Feeds works for anyone (src/server/feed-reader.ts).
  if (pathname === FEED_READER) return { door: "feed" };

  const kernel = /^\/s\/([^/]+)\/kernel$/.exec(pathname);
  if (kernel) {
    const space = kernel[1];
    if (!SPACE.test(space)) return refuse(404, "Not a space");
    if (!knock.upgrade) return refuse(426, "Expected a WebSocket");
    // A page on another site may open a WebSocket here (they aren't bound by CORS), so a browser's
    // client must come from this site's own pages.
    if (!sameOrigin(knock.origin, knock.url)) return refuse(403, "Not from this site");
    // Only the space's members may join it.
    const member = await accounts.member(knock.cookie, space).catch(() => null);
    if (!member) return refuse(403, "Only the space's members may join it");
    return { door: "join", space, member };
  }

  const at = spaceRoute(knock.url);
  if (at && SPACE.test(at.space) && (await accounts.exists(at.space).catch(() => false))) return { door: "route", ...at };
  return unrouted(knock.method);
}

/** A request no route answered: the site's files have GET and HEAD, and nothing else. */
export function unrouted(method: string): Decision {
  return method === "GET" || method === "HEAD" ? { door: "asset" } : refuse(405, "Method not allowed");
}
