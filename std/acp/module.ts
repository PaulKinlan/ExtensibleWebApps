// The `acp` door: an editor talks to one of a space's agents. ACP is the
// Agent Client Protocol (https://agentclientprotocol.com): an editor such as
// Zed, or any ACP client, starts a conversation with an agent, sends it what
// the person wrote, and shows what the agent says and does as it goes.
//
// MCP is the other way round (std/outside/module.ts): there the agent is
// outside and uses the app's tools. Here the agent is the app's own, one of
// the agent files it links (`<link rel="agent">`) that takes messages
// (`- message: true`), and the editor is where the person talks to it. It
// runs on the space's server, at /s/<space>/acp/<agent id>, with the agent's
// own permissions, the model key the space holds, and the same reviews: a
// change to data the agent doesn't own is asked about, on the members' open
// apps and, for a key made for the editor, in the editor's own prompt.
//
// Only the server's host can knock (src/server/acp.ts), once it has checked a
// member's agent key. Its manifest says `"only": "server"`, so the browser's
// kernel is built without this module: an app pays nothing for it, not even
// its name. Everything the door does is in door.ts, started the first time it
// is knocked at, so a space no editor talks to doesn't run it.
//
// A kernel module (docs/layers.md): a site that lists `acp` in kernel.json has it.

import type { KernelModule } from "../../src/kernel/modules";
import { part } from "../../src/kernel/part";
import type { AcpDoor } from "./door";

export default {
  name: "acp",
  apply(_ctx, kernel) {
    let door: Promise<AcpDoor> | undefined;
    let stopped = false;
    kernel.door("acp", async (request) => {
      // Only a space's server has agents an editor can reach: there is no way in to a browser's kernel.
      if (kernel.hosts.mode !== "server") return null;
      door ??= part("the acp module", () => import("./door")).then((m) => m.acpDoor(kernel));
      const answer = await door.catch((error) => {
        door = undefined;
        throw error;
      });
      if (stopped) return null;
      return answer.knock(request);
    });
    kernel.cleanup(() => {
      stopped = true;
      void door?.then((d) => d.stop()).catch(() => {});
    });
  },
} satisfies KernelModule;
