// A copy of a space's folder, to move the space to another host (the routes
// are transfer.ts). Kept apart from the routes so a space's kernel on
// Cloudflare, which alone can reach its folder, builds with only this.

import { checkPath, type Files } from "../seams/index.ts";

export const FORMAT = "extensible-web-apps/space";
/** The largest copy a host takes: a Durable Object's RPC carries at most 32 MiB, and base64 adds a third. */
export const MAX_BYTES = 24 * 1024 * 1024;

export interface SpaceCopy {
  format: typeof FORMAT;
  version: 1;
  space: string;
  exported: string;
  /** Each file in the folder, by path, as base64. */
  files: Record<string, string>;
}

const toBase64 = (data: Uint8Array) => {
  let text = "";
  for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Every file in a space's folder, as a copy to download. */
export async function exportSpace(folder: Files, space: string): Promise<SpaceCopy> {
  const files: Record<string, string> = {};
  for (const path of await folder.list("")) {
    const data = await folder.read(path);
    if (data) files[path] = toBase64(data);
  }
  return { format: FORMAT, version: 1, space, exported: new Date().toISOString(), files };
}

/** The copy, checked: or throws, saying what's wrong with it. */
export function checkCopy(value: unknown): SpaceCopy {
  const copy = value as Partial<SpaceCopy> | null;
  if (!copy || typeof copy !== "object" || copy.format !== FORMAT) throw new Error("That isn't a copy of a space");
  if (copy.version !== 1) throw new Error(`This server reads version 1 copies, not version ${String(copy.version)}`);
  if (!copy.files || typeof copy.files !== "object" || Array.isArray(copy.files)) throw new Error("The copy has no files");
  for (const [path, data] of Object.entries(copy.files)) {
    checkPath(path);
    if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error(`The copy's ${path} isn't base64`);
  }
  return copy as SpaceCopy;
}

/** Writes a copy into an empty folder. Throws, writing nothing, if the folder has anything in it. */
export async function importSpace(folder: Files, copy: SpaceCopy): Promise<{ files: number }> {
  checkCopy(copy);
  if ((await folder.list("")).length) throw new Error("A copy only goes into an empty space: make a new space for it");
  const entries = Object.entries(copy.files);
  for (const [path, data] of entries) await folder.write(path, fromBase64(data));
  return { files: entries.length };
}
