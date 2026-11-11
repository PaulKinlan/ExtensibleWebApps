// APIs that only exist in a page, which the kernel reaches through the host: a
// file each, found by name. bridges/<service>.ts answers the kernel's
// `bridge` messages for <service>. A service that needs the page is a new file
// here, so two changes that each add one don't edit the same lines. One that
// no page needs as it starts (customize: only once the panel is opened) is
// listed under `later`, and fetched the first time the kernel asks for it, so the
// page's script doesn't carry it.
//
// Each file's default export takes what it needs from the host and returns its
// methods.

import type { Opened } from "../../shared/protocol";
import type { places } from "../places";
import type { Arranger } from "../arrange";

export interface BridgeHost {
  /** This tab's id, as the kernel knows it. */
  tab: string;
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
  inspect?: () => Promise<void> | void;
  /** Arrange mode (arrange.ts), on a page that has Customize. */
  arrange?: () => Promise<Arranger>;
}

type Methods = Record<string, (...args: any[]) => unknown>;
type File = { default: (host: BridgeHost) => Methods };
const files = import.meta.glob<File>(["./*.ts", "!./index.ts", "!./customize.ts", "!./maker.ts", "!./transfer.ts", "!./folder.ts", "!./notify.ts", "!./share.ts", "!./account.ts", "!./device-model.ts"], { eager: true });
/** Bridges only some pages ever call, and never as they start: each is fetched the first time the kernel asks for it. */
const later = import.meta.glob<File>(["./customize.ts", "./maker.ts", "./transfer.ts", "./folder.ts", "./notify.ts", "./share.ts", "./account.ts", "./device-model.ts"]);

export function bridges(host: BridgeHost) {
  const services = new Map(Object.entries(files).map(([path, file]) => [path.slice(2, -3), file.default(host)]));
  const loading = new Map<string, Promise<Methods>>();
  /** A bridge fetched on demand, once; a fetch that fails is tried again the next time it is asked for. */
  const load = (service: string): Promise<Methods> | undefined => {
    const path = `./${service}.ts`;
    if (!Object.hasOwn(later, path)) return undefined;
    let made = loading.get(service);
    if (!made) {
      made = later[path]().then((file) => file.default(host));
      loading.set(service, made);
      made.catch(() => loading.delete(service));
    }
    return made;
  };
  return async (service: string, method: string, args: unknown[]): Promise<unknown> => {
    const call = (services.get(service) ?? (await load(service)))?.[method];
    if (!call) throw new Error(`The host has no ${service}.${method}`);
    return call(...args);
  };
}
