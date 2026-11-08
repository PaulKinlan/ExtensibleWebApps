// The `audio` service. Sound for plugins, played by the tab that runs the plugin workers.
// Found by name: this file is src/kernel/services/audio.ts, so it is `ctx.call("audio", …)`.

import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";

export default ({ hosts }: Kernel): ServiceProvider => {
  return {
    description: "Sound, played by the tab that runs the plugin workers. Audio runs in an AudioWorklet, never through hooks.",
    methods: {
      registerProcessor: { args: "(name, source)", returns: "true", needs: "audio", description: "Registers an AudioWorklet processor, from its source, under a name." },
      play: { args: "({ processor, ms?, options? })", returns: "{ played, state }", needs: "audio", description: "Plays a registered processor for `ms` milliseconds (300 by default), passing `options` as its processorOptions." },
    },
    capability: () => "audio",
    call: (_plugin, method, args, dispatch) => hosts.bridge("audio", method, args, dispatch),
  };
};
