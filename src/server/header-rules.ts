// The rules of a Cloudflare `_headers` file (public/_headers), read the same way by
// every host that isn't Cloudflare: the Node server (serve.ts) and Vite's development
// and preview servers (vite.site-headers.ts). Plugin workers take their policy from
// them, and pages theirs (Trusted Types, Permissions-Policy).
//
// Cloudflare joins a header two rules both give with a comma; here a later rule's
// value replaces an earlier one's. public/_headers keeps its rules from overlapping,
// so the two read the same.

import { existsSync, readFileSync } from "node:fs";

/**
 * The rules of a Cloudflare `_headers` file: a path (where `*` matches anything) on a line of its
 * own, then its headers, indented, one `Name: value` to a line. No file, no rules.
 */
export function headerRules(file: string): { path: RegExp; headers: Record<string, string> }[] {
  if (!existsSync(file)) return [];
  const rules: { path: RegExp; headers: Record<string, string> }[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim().split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      rules.push({ path: new RegExp(`^${pattern}$`), headers: {} });
    } else if (rules.length) {
      const at = line.indexOf(":");
      if (at > 0) rules[rules.length - 1].headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
  }
  return rules;
}
