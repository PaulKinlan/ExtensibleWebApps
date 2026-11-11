// The code of a plugin whose own file is only its manifest (the manifest's `code`, src/shared/protocol.ts).
//
// The kernel lists such a plugin, switches it and draws its stand-in from the manifest alone. Its code is in a
// .js file beside it, fetched here the first time the plugin starts, or the first time something shows or
// copies its source. The two are joined as one file: the manifest, then the code, which is what the plugin's
// worker runs. Fetched on first use itself: an app whose plugins are each one file never loads this.
import type { Installed } from "./remote";

/** The plugin's file and its `code` file as one. Asked for once; a fetch that failed is tried again the next time. */
export function whole(plugin: Installed): Promise<string> {
  const { code, name } = plugin.manifest;
  if (!plugin.href) return Promise.reject(new Error(`${name} keeps its code in another file (\`code\`), which only a plugin an app links can. Put the code in the plugin's own file`));
  const url = new URL(code as string, plugin.href);
  return (plugin.whole ??= fetch(url)
    .then((answer) => {
      if (!answer.ok) throw new Error(`answered ${answer.status}`);
      return answer.text();
    })
    .then(
      (text) => `${plugin.source}\n${text}`,
      (error: Error) => {
        plugin.whole = undefined;
        throw new Error(`${name}'s code at ${url.pathname} didn't load (${error.message}). Check you are online, then try again`);
      },
    ));
}
