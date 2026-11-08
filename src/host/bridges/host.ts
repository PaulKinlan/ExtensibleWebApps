// host: what the host itself can say about this tab.

import type { BridgeHost } from "./index";

export default ({ workers }: BridgeHost) => ({
  workerCount: () => workers.size,
});
