// The device's side of a space, in a browser kernel for one (/s/<space>/…): its sync with the
// space's kernel (device.ts), members' plugins (device-plugins.ts), the reviews the space's server
// asks (reviews.ts) and the apps members made and shared (device-made-apps.ts). The spaces module
// loads this file only in a kernel for a space, so a kernel that keeps no space doesn't carry it.

import type { Hosts } from "../../src/kernel/hosts";
import type { Collections } from "../../src/kernel/records";
import type { Reviews } from "../../src/kernel/review";
import type { Store } from "../../src/kernel/store";
import type { UserPlugins } from "../../src/kernel/user-plugins";
import { syncDevice } from "./device";
import { deviceMadeApps } from "./device-made-apps";
import { devicePlugins } from "./device-plugins";
import { deviceReviews } from "./reviews";

export function startDevice(url: string, store: Store, records: Collections, hosts: Hosts, userAdded: UserPlugins, reviews: Reviews, reopen: (app: string) => unknown) {
  const device = syncDevice(url, store, records, hosts);
  const shared = devicePlugins(userAdded, store, hosts, device, reopen);
  const stopReviews = deviceReviews(reviews, device);
  const made = deviceMadeApps(device, async () => (await device.state()).members);
  return {
    device,
    shared,
    made,
    stop() {
      stopReviews();
      shared.stop();
      made.stop();
      device.stop();
    },
  };
}
