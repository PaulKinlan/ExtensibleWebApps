// Kernel modules: the layer between the kernel core and std plugins
// (docs/layers.md). A module is trusted code that runs inside the kernel and
// gives plugins a service, such as `debug` or `agents`. An app may not use it,
// so a site lists the modules it runs in kernel.json, and only those are
// built into its kernel, in the browser and on its servers.
//
// A module is a Cordis plugin, in std/<name>/module.ts:
//
//   import { service } from "../../src/kernel/modules";
//   export default service("debug", (kernel) => ({ description, methods, capability, call }));
//
// or, for one that does more than give a service, a plugin object of its own:
//
//   export default { name: "debug", uses: ["llm"], apply(ctx, kernel) { kernel.provide("debug", …); } };
//
// The build reads kernel.json and hands the kernel the modules it lists
// (vite.kernel-modules.ts), so the core never names one. A module listed
// there with no std/<name>/module.ts, or one that `uses` a module the site
// doesn't list, stops the build or the kernel: it never quietly goes without.

import type { Kernel } from "./services/index";
import type { ServiceProvider } from "./remote";
import { RESERVED } from "./manifest";

/** What a module is given: the kernel's parts, and ways to add to it. */
export interface ModuleKernel extends Kernel {
  /** Adds a service plugins call with ctx.call(name, …). Taken back when the module stops. */
  provide(name: string, provider: ServiceProvider): void;
  /** Adds a command the page can run (window.__host.command(name, arg)), for tests and developer tools. */
  command(name: string, run: (arg: unknown) => unknown): void;
}

/** A module: a Cordis plugin the kernel runs with its parts as the config. */
export interface KernelModule {
  name: string;
  /** Other modules it needs, by name. The kernel refuses to start without them. */
  uses?: string[];
  apply(ctx: any, kernel: ModuleKernel): void;
}

/** A module that only gives a service, named after the module. */
export function service(name: string, make: (kernel: ModuleKernel) => ServiceProvider, uses: string[] = []): KernelModule {
  return {
    name,
    uses,
    apply(_ctx, kernel) {
      kernel.provide(name, make(kernel));
    },
  };
}

/**
 * Runs each module as a Cordis plugin on the kernel's root context, in the order kernel.json lists them.
 * Services and commands they add go into the kernel's tables, and come out again if a module is disposed.
 */
export function loadModules(modules: KernelModule[], kernel: Kernel, services: Record<string, ServiceProvider>, commands: Map<string, (arg: unknown) => unknown>) {
  const names = new Set(modules.map((m) => m.name));
  for (const module of modules) {
    const missing = (module.uses ?? []).filter((name) => !names.has(name));
    if (missing.length) throw new Error(`The ${module.name} module needs ${missing.join(", ")}, which kernel.json doesn't list`);
  }
  for (const module of modules) {
    kernel.root.plugin(
      {
        name: `module:${module.name}`,
        apply(ctx: any) {
          const own: ModuleKernel = {
            ...kernel,
            provide(name, provider) {
              if (Object.hasOwn(services, name)) throw new Error(`The ${module.name} module can't provide ${name}: the kernel already has a service by that name`);
              services[name] = provider;
              RESERVED.add(name);
              ctx.on("dispose", () => void delete services[name]);
            },
            command(name, run) {
              if (commands.has(name)) throw new Error(`The ${module.name} module can't add the command ${name}: it is taken`);
              commands.set(name, run);
              ctx.on("dispose", () => void commands.delete(name));
            },
          };
          // Cordis waits on whatever apply returns, and a context is thenable: return nothing.
          module.apply(ctx, own);
        },
      },
    );
  }
}
