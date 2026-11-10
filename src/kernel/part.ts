// A part of the kernel that is a file of its own, fetched the first time it is used (a kernel module, the
// reference, authoring). When the file can't be fetched the browser says only "Failed to fetch dynamically
// imported module: <address>", which tells the person nothing they can act on. There are two reasons it happens:
// the device is offline and has never used that part, or the page was opened before the site was last deployed
// and the part's old file has since left the server (scripts/keep-assets.mjs keeps them for a long while, and
// the service worker tells open pages when one is gone: sw.js). Either way the person is told which, and what to do.

/** What each browser says when a module's file didn't arrive (Chrome, Firefox, Safari). An error thrown by the module's own code isn't one of these. */
const NOT_FETCHED = /dynamically imported module|Importing a module script failed/i;

/** `what` names the part as a person would ("the reference", "the llm module"). */
export const part = <T>(what: string, load: () => Promise<T>): Promise<T> =>
  load().catch((error: unknown) => {
    if (!NOT_FETCHED.test(error instanceof Error ? error.message : String(error))) throw error;
    throw new Error(
      globalThis.navigator?.onLine === false
        ? `Couldn't load ${what}: this device is offline and hasn't used that part before, so it isn't kept here. Try again when you're back online.`
        : `Couldn't load ${what}: this page was opened before the site was last updated, and that part of the older version is no longer there. Reload the page, then try again.`,
    );
  });
