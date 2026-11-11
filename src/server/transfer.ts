// Moving a space between hosts: its owner downloads a copy of the space's
// folder from one host and loads it into an empty space on another (a space
// on Cloudflare moved to a Node machine, say, or back). Both hosts answer the
// same two routes, before the accounts (src/server/auth/accounts.ts) do:
//
//   GET  /auth/spaces/<name>/export   the space's folder, as one JSON file (its owner only)
//   POST /auth/spaces/<name>/import   loads such a file into the space, which must be empty (its owner only)
//
// The copy is the kernel's folder: every collection and the change log,
// plugins members shared, the apps opened in the space (so its server
// plugins start again on the new host), scheduled jobs and settings. It
// isn't the people: members, invites and passkeys are accounts, which belong
// to a host. Whoever loads it is the new space's owner and invites the others
// again. Records stamped with a member's id on the old host (`by`, or a
// plugin's own field) keep that id, which names nobody on the new one.
//
// The host gives the space's folder (`folder`) and is told when a copy has
// gone in (`loaded`), to start the space's kernel on it: on Node the kernel
// reads files on disk, on Cloudflare the folder is the kernel's own SQLite
// database, which only the kernel's Durable Object can reach.

import { bodyOf } from "./auth/accounts.ts";
import { checkCopy, MAX_BYTES, type SpaceCopy } from "./space-copy.ts";

export { exportSpace, importSpace } from "./space-copy.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/** What a host gives the routes. */
export interface TransferHost {
  /** The role of whoever sent the request in the space, or null if they aren't in it (or not signed in). */
  role(request: Request, space: string): Promise<"owner" | "editor" | "reader" | null>;
  /** Downloads the space's folder. */
  exportSpace(space: string): Promise<SpaceCopy>;
  /** Loads a checked copy into the space, which must be empty, and starts its kernel on it. */
  importSpace(space: string, copy: SpaceCopy, origin: string): Promise<{ files: number }>;
}

const ROUTE = /^\/auth\/spaces\/([a-z0-9][a-z0-9-]{0,62})\/(export|import)$/;

/** Answers the two routes, or gives undefined for any other request. */
export async function transferRoute(request: Request, host: TransferHost): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = ROUTE.exec(url.pathname);
  if (!match) return undefined;
  const [, space, action] = match;
  if ((action === "export" && request.method !== "GET") || (action === "import" && request.method !== "POST")) return json({ error: "Method not allowed" }, 405);
  // A form on another site can't load a copy into someone's space.
  if (action === "import" && request.headers.get("origin") !== url.origin) return json({ error: "Not from this site" }, 403);
  const role = await host.role(request, space);
  if (role !== "owner") return json({ error: "Only the space's owner can move it" }, role ? 403 : 401);
  if (action === "export") {
    const copy = await host.exportSpace(space);
    return json(copy, 200, { "content-disposition": `attachment; filename="${space}-${copy.exported.slice(0, 10)}.space.json"` });
  }
  const text = await bodyOf(request, MAX_BYTES);
  if (text === null) return json({ error: `A copy is at most ${MAX_BYTES / 1024 / 1024} MB` }, 413);
  let copy: SpaceCopy;
  try {
    copy = checkCopy(JSON.parse(text));
  } catch (error) {
    return json({ error: error instanceof SyntaxError ? "JSON only" : (error as Error).message }, 400);
  }
  try {
    return json({ ok: true, ...(await host.importSpace(space, copy, url.origin)) });
  } catch (error) {
    return json({ error: (error as Error).message }, 409);
  }
}
