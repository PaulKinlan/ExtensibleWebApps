// This kernel's sync with its space, once it has started (device.ts), for the `sync` service
// (service.ts). Its own file, so the service can be in every kernel while the device's side of a
// space loads only in a kernel for a space (on-device.ts).

import type { syncDevice } from "./device";

/** This kernel's sync, if it keeps a copy of a space, and who hears when what it has changes (service.ts). */
export const thisDevice: { sync?: ReturnType<typeof syncDevice>; changed: Set<() => void> } = { changed: new Set() };
