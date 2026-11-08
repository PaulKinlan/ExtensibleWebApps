// The `audio` service. Sound for plugins, played by the tab that runs the plugin workers.
// Found by name: this file is src/kernel/services/audio.ts, so it is `ctx.call("audio", …)`.

import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";

export default ({ hosts }: Kernel): ServiceProvider => {
  return {
    description: "Sound, played by the tab that runs the plugin workers. Audio runs in an AudioWorklet, never through hooks.",
    methods: {
      registerProcessor: { args: "(name, source)", returns: "true", needs: "audio", description: "Registers an AudioWorklet processor, from its source, under a name." },
      play: {
        args: "({ processor, ms?, at?, options? })",
        returns: "{ played, state }",
        needs: "audio",
        description:
          "Plays a registered processor for `ms` milliseconds (300 by default), passing `options` as its processorOptions. With `at`, a time in ms since the epoch (Date.now()), it starts then on the audio clock: ask about 100 ms ahead. The processor's options get `start`, in the audio clock's seconds; output silence until currentTime reaches it to begin on the exact sample.",
      },
    },
    capability: () => "audio",
    call: (_plugin, method, args, dispatch) => hosts.bridge("audio", method, args, dispatch),
  };
};
