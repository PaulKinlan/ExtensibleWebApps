// The code of a plugin whose own file is only its manifest (the manifest's `code`, src/shared/protocol.ts).
//
// Such a plugin's place is held by a stand-in, so no first view needs its code. The page fetches it a few
// seconds into a visit (prefetch.ts), with the templates it names and the elements those use, so all of them
// are there offline. When the kernel asks the page to start the plugin, the same copy is put after the
// manifest and the worker runs the two as one file: the code that runs is the one whose templates were warmed
// with it, never a newer or older copy fetched apart from them.
//
// A file of its own, fetched when first needed: a page with no such plugin never has it.
import { templatesIn, warmElements } from "./prefetch";
import { loadFile } from "./templates";

/** `code: "panel.code.js"` in a manifest, as the kernel's reader takes it: either quote, the key quoted or not. */
const CODE = /(?<![\w$])(["']?)code\1\s*:\s*(["'])([\w./-]+\.js)\2/;
const codes = new Map<string, Promise<string>>();

/** A code file, fetched once for this page; a fetch that failed is tried again the next time. */
export function codeOf(url: string): Promise<string> {
  let code = codes.get(url);
  if (!code) {
    code = fetch(url, { credentials: "same-origin" }).then((answer) => {
      if (new URL(answer.url).origin !== location.origin) throw new Error("it redirected to another site");
      if (!answer.ok) throw new Error(`it answered ${answer.status}`);
      return answer.text();
    });
    codes.set(url, code);
    code.catch(() => codes.delete(url));
  }
  return code;
}

/** Fetches the code file a plugin's manifest names, then the templates that code names and their elements. */
export async function warm(href: string, source: string): Promise<void> {
  const named = CODE.exec(source);
  if (!named) return;
  const code = await codeOf(new URL(named[3], new URL(href, location.href)).href);
  for (const src of templatesIn(href, code)) loadFile(src).then(warmElements, () => {});
}

/** The latest start asked of each instance: one still waiting for its code gives way to a later start, or to a stop. */
const starts = new Map<string, object>();

/**
 * Starts a plugin the kernel asked for (`spawn`) once its code is here. When the code can't be fetched nothing
 * starts: the kernel, which is waiting for the worker, tells the person, and the console has the address.
 */
export async function start(asked: { plugin: string; source: string; network: boolean; code?: string }, spawn: (plugin: string, source: string, network: boolean) => void): Promise<void> {
  const mine = {};
  starts.set(asked.plugin, mine);
  const rest = await codeOf(asked.code as string).catch((error: Error) => console.error(`${asked.plugin}'s code at ${asked.code} didn't load: ${error.message}`));
  if (rest === undefined || starts.get(asked.plugin) !== mine) return;
  starts.delete(asked.plugin);
  spawn(asked.plugin, `${asked.source}\n${rest}`, asked.network);
}

/** The kernel stopped an instance: a start of it still waiting for its code is dropped. */
export const stop = (plugin: string) => void starts.delete(plugin);
