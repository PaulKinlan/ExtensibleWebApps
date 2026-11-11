// An app as a link. A made app's recipe is its files and nothing else:
// app.html and the plugins, templates, styles and agents beside it. None of
// the data anyone put into it. Packed here into the part of an address after
// the #, which a browser never sends to a server: the link is the app, so
// nothing is kept on the site and it opens for someone who isn't signed in
// (std/maker/module.ts: link, linked, takeLink).
//
//   /new/#app=<the recipe, compressed, in letters an address can carry>
//
// Fetched only when a link is made or opened.

export interface Recipe {
  /** The format: 1. An unknown one is refused, never guessed at. */
  v: 1;
  name: string;
  files: { name: string; text: string }[];
}

/** What starts the part of the address that holds a recipe. */
export const MARK = "app=";
/** The longest link made. Longer ones are cut short by chat and mail apps, and a browser may refuse them. */
export const MAX_LINK = 32_000;
/** The most a recipe may unpack to: a small link can't be made to fill the device. */
const MAX_UNPACKED = 3_200_000;

const through = async (bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> => {
  const writer = stream.writable.getWriter();
  // The write settles only as the other end is read, so its failure is taken there.
  void writer.write(bytes as BufferSource).then(() => writer.close()).catch(() => {});
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Error("too big");
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const part of parts) all.set(part, (at += part.length) - part.length);
  return all;
};

/** The recipe as the text after `app=`. */
export async function pack(recipe: Recipe): Promise<string> {
  const packed = await through(new TextEncoder().encode(JSON.stringify(recipe)), new CompressionStream("deflate-raw"));
  let binary = "";
  for (let i = 0; i < packed.length; i += 0x8000) binary += String.fromCharCode(...packed.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The recipe a link carries. Throws, in words for the person, if the link is damaged or isn't one. */
export async function unpack(text: string): Promise<Recipe> {
  const damaged = "This link is damaged or cut short, so the app in it can't be read. Ask whoever sent it to share it again";
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error(damaged);
  let value: unknown;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    value = JSON.parse(new TextDecoder().decode(await through(bytes, new DecompressionStream("deflate-raw"), MAX_UNPACKED)));
  } catch {
    throw new Error(damaged);
  }
  const recipe = value as Partial<Recipe> | null;
  if (!recipe || typeof recipe !== "object" || typeof recipe.v !== "number") throw new Error(damaged);
  if (recipe.v !== 1) throw new Error("This link was made by a newer version of this site than the one you have open. Reload the page and open the link again");
  if (typeof recipe.name !== "string" || !Array.isArray(recipe.files) || recipe.files.some((f) => !f || typeof f.name !== "string" || typeof f.text !== "string")) throw new Error(damaged);
  return { v: 1, name: recipe.name, files: recipe.files.map((f) => ({ name: f.name, text: f.text })) };
}
