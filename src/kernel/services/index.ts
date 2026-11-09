// The kernel's services, one file each. A file here named `x.ts` is the `x`
// service: plugins call it with `ctx.call("x", method, ...args)`. Its default
// export takes the kernel's parts and returns the service. Nothing lists the
// files, so adding a service is adding a file, and two changes that each add
// one never touch the same lines.
//
// Services that are part of a larger module (settings, data, plugins) are
// still set in kernel.ts, next to the module that makes them.

import type { apps } from "../apps";
import type { Hosts } from "../hosts";
import type { Collections } from "../records";
import type { Reference } from "../reference";
import type { RemotePlugins, ServiceProvider } from "../remote";
import type { Store } from "../store";

/** What a service file can use. */
export interface Kernel {
  root: any;
  store: Store;
  hosts: Hosts;
  remote: RemotePlugins;
  apps: ReturnType<typeof apps>;
  /** Asks the person to review a write by a plugin instance; throws unless they allow it. With `once`, the card offers no "Always allow" and no earlier grant answers it. */
  reviewed(instance: string, place: string, target: string, before: string, after: string, reason: unknown, dispatch: { trace?: string }, options?: { once?: boolean }): Promise<string>;
  /** The kernel's API reference, as it is now. */
  describe(): Reference;
  /** The collections: their registry, and every write to them as it happens. */
  collections: Collections;
}

const files = import.meta.glob<{ default: (kernel: Kernel) => ServiceProvider }>(["./*.ts", "!./index.ts"], { eager: true });

/** Each service file, by name, made with the kernel's parts. */
export function loadServices(kernel: Kernel): Record<string, ServiceProvider> {
  return Object.fromEntries(Object.entries(files).map(([path, file]) => [path.slice(2, -3), file.default(kernel)]));
}
