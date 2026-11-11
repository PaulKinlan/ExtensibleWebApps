// host: what the host itself can say about this tab. Only the debug module asks (its leak check), so the page
// fetches this the first time it does (index.ts, `later`).

import type { BridgeHost } from "./index";

export default ({ workers }: BridgeHost) => ({
  workerCount: () => workers.size,
});
