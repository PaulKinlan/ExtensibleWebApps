// The kernel's entry for a space, on a server: the same kernel as the
// browser's (src/kernel/kernel.ts), in a worker thread of its own. It sets the
// environment, then the kernel starts. Imports run in order, so the
// environment is set before any of the kernel's code runs.
//
// Vite builds this (`npm run build:server`), since the kernel imports plugin
// sources as text and finds its services by name, as it does in the browser.

import "./space-env";
import "../kernel/kernel";
import { parentPort } from "node:worker_threads";

parentPort!.postMessage({ t: "ready" });
