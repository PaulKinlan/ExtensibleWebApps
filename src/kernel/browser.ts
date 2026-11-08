// The kernel's entry in the browser: a shared worker every tab connects to,
// or a dedicated worker for one tab where shared workers aren't available.
// It sets the environment, then the kernel (kernel.ts) starts. Imports run in
// order, so the environment is set before any of the kernel's code runs.

import "./browser-env";
import "./kernel";
