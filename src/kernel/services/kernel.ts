// The `kernel` service. The kernel itself: ping, its hooks, and its own reference.
// Found by name: this file is src/kernel/services/kernel.ts, so it is `ctx.call("kernel", …)`.

import { hooks } from "../hooks";
import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";

export default ({ describe }: Kernel): ServiceProvider => {
  return {
    description: "The kernel itself.",
    methods: {
      ping: { args: "()", returns: '"pong"', description: "Answers at once; for checking the connection." },
      hooks: { args: "()", returns: "{ [name]: { mode, timeoutMs?, onFailure?, args?, description? } }", description: "Every hook and its contract." },
      reference: { args: "()", returns: "the reference, as data", description: "This API reference, as the kernel describes itself." },
    },
    capability: () => undefined,
    call: (_plugin, method) => {
      if (method === "ping") return "pong";
      if (method === "hooks") return Object.fromEntries(hooks);
      if (method === "reference") return describe();
      throw new Error(`kernel.${method} is not a method`);
    },
  };
};
