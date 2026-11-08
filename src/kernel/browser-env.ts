// The browser's environment for the kernel (see env.ts). A shared worker gets
// a port per tab; a dedicated worker gets one port from its tab. The folder
// comes from the first tab (its origin private file system, or a folder the
// person picked), so it isn't set here.

import { setEnv } from "./env";

declare const SharedWorkerGlobalScope: { new (): unknown } | undefined;
const shared = typeof SharedWorkerGlobalScope !== "undefined" && self instanceof SharedWorkerGlobalScope;

// A page in a space (/s/<space>/…) starts a kernel of that space's own, named after it.
const space = /^kernel:([a-z0-9][a-z0-9-]{0,62})$/.exec(self.name)?.[1];

setEnv({
  kind: shared ? "shared" : "dedicated",
  origin: self.location.origin,
  ...(space ? { space } : {}),
  connect(accept) {
    if (shared) (self as any).onconnect = (e: MessageEvent) => accept(e.ports[0]);
    else
      self.onmessage = (e: MessageEvent) => {
        if (e.data?.t === "connect") accept(e.ports[0]);
      };
  },
  onError(report) {
    self.addEventListener("error", (e) => report("kernel:error", String((e as ErrorEvent).message ?? e)));
    self.addEventListener("unhandledrejection", (e) => {
      const reason = (e as PromiseRejectionEvent).reason;
      report("kernel:unhandled", String(reason instanceof Error ? reason.message : reason));
    });
  },
});
