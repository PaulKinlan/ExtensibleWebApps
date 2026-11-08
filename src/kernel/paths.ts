// Path checks for anything a plugin asks to read or write in the data
// folder, as the Markdown editor checks them: relative paths only, no `..`,
// nothing hidden, and nothing in the folders the platform keeps for itself.
// That last rule is what stops a plugin from installing or approving
// plugins by writing files.

/** Top-level folders and files that belong to the platform. */
export const PLATFORM = new Set([
  "plugins",
  "plugin-data",
  "plugins.json",
  "grants.json",
  "changes.json",
  "notes.json",
  "collections",
  "user",
  "user-plugins.json",
  "secrets.json",
  // A space's sync log and a device's sync state (sync.ts, sync-device.ts), and a server's apps (server-apps.ts).
  "sync",
  "server",
  // Plugins' scheduled jobs (services/schedule.ts).
  "schedule",
]);

export class PathError extends Error {}

/** Returns the path's segments, or throws a PathError saying why it is refused. */
export function checkPath(path: unknown): string[] {
  if (typeof path !== "string" || !path) throw new PathError("A path must be a non-empty string");
  if (path.length > 512) throw new PathError("The path is too long");
  if (path.startsWith("/") || path.includes("\\")) throw new PathError(`${path}: paths are relative and use /`);
  if (/[\u0000-\u001f:*?"<>|]/.test(path)) throw new PathError(`${path}: the path has a character files can't have`);
  const parts = path.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") throw new PathError(`${path}: no empty, . or .. segments`);
    if (part.startsWith(".")) throw new PathError(`${path}: hidden files and folders are off limits`);
  }
  if (PLATFORM.has(parts[0])) throw new PathError(`${path}: ${parts[0]} belongs to the platform`);
  if (parts.length < 2) throw new PathError(`${path}: files live in a folder, such as exports/${path}`);
  return parts;
}
