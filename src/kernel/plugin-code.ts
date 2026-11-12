// The whole source of a plugin whose own file is only its manifest (the manifest's `code`, src/shared/protocol.ts),
// for showing it or copying it: the manifest, then the code from the .js file beside it, as one file.
//
// Starting such a plugin doesn't come here: the page that starts its worker adds the code (src/host/plugin-code.ts),
// from the copy it fetched with the plugin's templates. Fetched on first use itself: an app whose plugins are each
// one file never loads this.
import type { Installed } from "./remote";

export async function whole(plugin: Installed): Promise<string> {
  const url = new URL(plugin.manifest.code as string, plugin.href);
  const answer = await fetch(url).catch((error: Error) => error);
  if (!(answer instanceof Response && answer.ok)) throw new Error(`${plugin.manifest.name}'s code at ${url.pathname} didn't load (${answer instanceof Response ? `answered ${answer.status}` : answer.message}). Check you are online, then try again`);
  return `${plugin.source}\n${await answer.text()}`;
}
