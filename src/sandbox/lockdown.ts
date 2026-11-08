// Takes away the storage a plugin's worker would otherwise share with the
// page. Plugin workers run on the site's own origin, so without this a
// plugin could open the data folder (navigator.storage), the site's
// databases and caches, or a BroadcastChannel, and read or change what the
// kernel keeps there (secrets.json, grants.json, other plugins' data)
// without asking. A plugin reaches its data only through ctx, where the gate
// checks it.
//
// The accessors are deleted from the objects and their prototypes before the
// plugin's code runs. A worker can't make a fresh realm to get them back:
// it has no iframes, and its policy stops it starting workers.

const GLOBALS = ["BroadcastChannel", "caches", "indexedDB", "SharedWorker"];
const NAVIGATOR = ["locks", "serviceWorker", "storage"];

function remove(from: object, names: string[]) {
  for (let o: object | null = from; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const name of names) if (Object.hasOwn(o, name)) Reflect.deleteProperty(o, name);
  }
}

export function lockdown(): void {
  remove(globalThis, GLOBALS);
  remove(navigator, NAVIGATOR);
}
