// APIs that only exist in a page, which the kernel reaches through the host: a
// file each, found by name. bridges/<service>.ts answers the kernel's
// `bridge` messages for <service>. A service that needs the page is a new file
// here, so two changes that each add one don't edit the same lines.
//
// Each file's default export takes what it needs from the host and returns its
// methods.

import type { Opened } from "../../shared/protocol";
import type { places } from "../places";

export interface BridgeHost {
  /** The plugin workers this tab runs, by plugin id. */
  workers: Map<string, Worker>;
  /** Where plugins' views can go on this page. */
  places: ReturnType<typeof places>;
  /** The slots plugins declare in their views: each one's data, for the plugin asking, which then hears when they change. */
  declared: (plugin: string, name: string) => { data: Record<string, string> }[];
  /** Runs a page command in the kernel, as the workbench does: a bridge that hears from the page (a WebMCP tool's call) answers through it. */
  command: (name: string, arg?: unknown) => Promise<unknown>;
  /** The plugins running for this tab's app, as the kernel last said. */
  running: () => Opened[];
  /** Starts inspect mode (inspect.ts), on a page that has it. */
  inspect?: () => void;
}

type Methods = Record<string, (...args: any[]) => unknown>;
const files = import.meta.glob<{ default: (host: BridgeHost) => Methods }>(["./*.ts", "!./index.ts"], { eager: true });

export function bridges(host: BridgeHost) {
  const services = new Map(Object.entries(files).map(([path, file]) => [path.slice(2, -3), file.default(host)]));
  return async (service: string, method: string, args: unknown[]): Promise<unknown> => {
    const call = services.get(service)?.[method];
    if (!call) throw new Error(`The host has no ${service}.${method}`);
    return call(...args);
  };
}
