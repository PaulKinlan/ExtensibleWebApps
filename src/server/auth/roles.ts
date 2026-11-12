// The roles of a space's members, apart from the accounts so a space's own kernel can read a role without carrying the accounts.

/**
 * What a member may do in a space. Its one owner does everything, and says who else is in it and as what; an
 * editor changes what the space keeps; a reader sees it and changes nothing (the space's server refuses what a
 * reader sends: src/server/signed.ts, std/spaces/permissions.ts).
 */
export type Role = "owner" | "editor" | "reader";

/** A role as kept. Spaces made before there were readers kept "member" for everyone but the owner: that is an editor. */
export const roleOf = (kept: unknown): Role | undefined => (kept === "owner" || kept === "reader" ? kept : kept === "editor" || kept === "member" ? "editor" : undefined);
