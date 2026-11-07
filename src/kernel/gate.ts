// The capability gate. Every message a sandboxed plugin sends is checked
// here against its manifest before it reaches anything else.

import type { Manifest } from "../shared/protocol";
import { record } from "./trace";

/** Editor-style permissions (from the Markdown editor) expressed as capabilities. */
export const EDITOR_PERMISSIONS: Record<string, string[]> = {
  "post:read": ["hook:listen:note:*"],
  "post:write": ["hook:intercept:data:beforeWrite"],
  ui: ["ui"],
};

export function capabilities(manifest: Manifest): Set<string> {
  const out = new Set<string>();
  for (const permission of manifest.permissions ?? []) {
    for (const cap of EDITOR_PERMISSIONS[permission] ?? [permission]) out.add(cap);
  }
  return out;
}

/** True if `caps` grants `wanted`, allowing a trailing `*` wildcard. */
export function grants(caps: Set<string>, wanted: string): boolean {
  if (caps.has(wanted)) return true;
  for (const cap of caps) {
    if (cap.endsWith("*") && wanted.startsWith(cap.slice(0, -1))) return true;
  }
  return false;
}

export function check(plugin: string, caps: Set<string>, wanted: string): boolean {
  if (grants(caps, wanted)) return true;
  record({ kind: "denied", name: wanted, plugin, detail: "missing capability" });
  return false;
}
