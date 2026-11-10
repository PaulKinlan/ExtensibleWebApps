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
import type { MovesStore } from "../moves";
import type { Collections } from "../records";
import type { Reference } from "../reference";
import type { RemotePlugins, ServiceProvider } from "../remote";
import type { Store } from "../store";
import type { Reviews } from "../review";
import type { UserPlugins } from "../user-plugins";

/** What a service file can use. */
export interface Kernel {
  root: any;
  store: Store;
  hosts: Hosts;
  remote: RemotePlugins;
  apps: ReturnType<typeof apps>;
  /** Asks the person to review a write by a plugin instance; throws unless they allow it. With `once`, the card offers no "Always allow" and no earlier grant answers it. */
  reviewed(instance: string, place: string, target: string, before: string, after: string, reason: unknown, dispatch: { trace?: string }, options?: { once?: boolean }): Promise<string>;
  /** The kernel's API reference, as it is now. It describes every module the site lists, so it starts them all first. */
  describe(): Promise<Reference>;
  /**
   * Starts every kernel module the site lists that isn't running yet (modules.ts). For code that reads every
   * service's methods rather than calling one: an agent's tools, the reference.
   */
  whole(): Promise<void>;
  /** The collections: their registry, and every write to them as it happens. */
  collections: Collections;
  /** Review cards: asked, answered, and relayed to members' devices from a space's server. */
  reviews: Reviews;
  /** The person's own plugins for each app (user-plugins.ts). */
  userAdded: UserPlugins;
  /** Where the person moved plugins' views in each app (moves.ts). */
  moved: MovesStore;
  /** Opens an app again in every tab that has it open, after its plugins changed. */
  reopen(app: string): Promise<void>;
  /** The app open in a tab: its folder, as the page names it (`demos/markdown-editor`). Undefined for a tab with no app (the workbench). */
  appIn(tab: string): string | undefined;
  /** Whether the kernel has its data folder yet (the first page said hello). Until then, root hears internal/started once it has. */
  started(): boolean;
}

const files = import.meta.glob<{ default: (kernel: Kernel) => ServiceProvider }>(["./*.ts", "!./index.ts"], { eager: true });

/** Each service file, by name, made with the kernel's parts. */
export function loadServices(kernel: Kernel): Record<string, ServiceProvider> {
  return Object.fromEntries(Object.entries(files).map(([path, file]) => [path.slice(2, -3), file.default(kernel)]));
}
