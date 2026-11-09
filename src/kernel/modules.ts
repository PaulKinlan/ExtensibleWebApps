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
// Everything a module adds goes through `kernel` (provide, command, hook,
// cleanup, and `kernel.root`, which is the module's own Cordis context), and
// each is a Cordis effect on that context. So, as
// with any Cordis plugin, disposing a module takes back all it added, and the
// modules that `use` it (Cordis `inject`) stop with it and start again when it
// comes back. A module never calls defineHook itself: tests/checks/kernel-layers.mjs
// fails if one does.
//
// The build reads kernel.json and hands the kernel the modules it lists
// (vite.kernel-modules.ts), so the core never names one. A module listed
// there with no std/<name>/module.ts, or one that `uses` a module the site
// doesn't list, stops the build or the kernel: it never quietly goes without.

import type { Kernel } from "./services/index";
import type { ServiceProvider } from "./remote";
import type { RouteRequest, RouteResponse } from "./routes";
import { RESERVED } from "./manifest";
import { defineHook, type HookSpec } from "./hooks";
import { record } from "./trace";

/** The Cordis service a module's service is also registered as, so other modules can `inject` it. */
const cordisName = (name: string) => `kernel.${name}`;

/** What a module is given: the kernel's parts, and ways to add to it. */
export interface ModuleKernel extends Kernel {
  /** Adds a service plugins call with ctx.call(name, …). Taken back when the module stops. */
  provide(name: string, provider: ServiceProvider): void;
  /** Adds a command the page can run (window.__host.command(name, arg)), for tests and developer tools. */
  command(name: string, run: (arg: unknown) => unknown): void;
  /**
   * Answers a door the server's host lets in (`mcp`: an MCP request from a member's agent, src/server/mcp.ts),
   * which comes with the member it is for. Only the host can knock: no page or client reaches a door.
   */
  door(name: string, answer: (request: RouteRequest) => Promise<RouteResponse | null> | RouteResponse | null): void;
  /** Defines a hook plugins can listen to. Taken back when the module stops. */
  hook(name: string, spec: HookSpec): void;
  /** Runs when the module stops: clear its timers, end what waits on it. */
  cleanup(fn: () => void): void;
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
 * Services, commands and hooks they add go into the kernel's tables as Cordis effects, so they come out
 * again when the module is disposed. Returns `restart(name)`, which disposes a module and runs it again.
 */
export function loadModules(
  modules: KernelModule[],
  kernel: Kernel,
  services: Record<string, ServiceProvider>,
  commands: Map<string, (arg: unknown) => unknown>,
  /** The doors modules answer (ModuleKernel.door), by name. */
  doors: Map<string, (request: RouteRequest) => Promise<RouteResponse | null> | RouteResponse | null>,
  /** The kernel's own page commands, which a module may not take. */
  coreCommand: (name: string) => boolean,
) {
  const names = new Set(modules.map((m) => m.name));
  for (const module of modules) {
    const missing = (module.uses ?? []).filter((name) => !names.has(name));
    if (missing.length) throw new Error(`The ${module.name} module needs ${missing.join(", ")}, which kernel.json doesn't list`);
  }
  const plugins = new Map(
    modules.map((module) => [
      module.name,
      {
        name: `module:${module.name}`,
        // Cordis starts it once the modules it uses are running, and stops it whenever one of them stops.
        inject: (module.uses ?? []).map(cordisName),
        apply(ctx: any) {
          const own: ModuleKernel = {
            ...kernel,
            // The module's own context stands in for the root: hooks it emits reach everyone, and
            // what it listens to or starts with root.on and root.plugin stops with it.
            root: ctx,
            provide(name, provider) {
              if (Object.hasOwn(services, name)) throw new Error(`The ${module.name} module can't provide ${name}: the kernel already has a service by that name`);
              RESERVED.add(name);
              ctx.effect(() => {
                services[name] = provider;
                return () => void delete services[name];
              }, `service ${name}`);
              ctx.provide(cordisName(name), provider);
            },
            command(name, run) {
              if (coreCommand(name)) throw new Error(`The ${module.name} module can't add the command ${name}: it is the kernel's`);
              if (commands.has(name)) throw new Error(`The ${module.name} module can't add the command ${name}: it is taken`);
              ctx.effect(() => {
                commands.set(name, run);
                return () => void commands.delete(name);
              }, `command ${name}`);
            },
            door(name, answer) {
              if (doors.has(name)) throw new Error(`The ${module.name} module can't answer the door ${name}: another module does`);
              ctx.effect(() => {
                doors.set(name, answer);
                return () => void doors.delete(name);
              }, `door ${name}`);
            },
            hook(name, spec) {
              ctx.effect(() => defineHook(name, spec), `hook ${name}`);
            },
            cleanup(fn) {
              ctx.effect(() => fn, "cleanup");
            },
          };
          // The first effect, so it is the last undone: "stop" is traced once all the module added is gone.
          ctx.effect(() => {
            record({ kind: "lifecycle", name: "module:start", plugin: module.name });
            return () => record({ kind: "lifecycle", name: "module:stop", plugin: module.name });
          }, "trace");
          // Cordis waits on whatever apply returns, and a context is thenable: return nothing.
          module.apply(ctx, own);
        },
      },
    ]),
  );
  const fibers = new Map<string, any>();
  for (const [name, plugin] of plugins) fibers.set(name, kernel.root.plugin(plugin));
  // Cordis applies a plugin after this call returns, and one that injects others once they're running.
  // A module that fails to start is an error in the trace, and the services it would give are missing.
  const ready = Promise.all(
    modules.map((m) =>
      Promise.resolve(fibers.get(m.name)).catch((error: unknown) => {
        record({ kind: "error", name: "module:failed", plugin: m.name, detail: error instanceof Error ? error.message : String(error) });
      }),
    ),
  ).then(() => {});
  return {
    /** Settles once every module has started or failed. */
    ready,
    /** Stops a module, and the modules that use it, then starts it again; they start again with it. */
    async restart(name: string) {
      const plugin = plugins.get(name);
      if (!plugin) throw new Error(`No module ${name}`);
      await fibers.get(name).dispose();
      fibers.set(name, kernel.root.plugin(plugin));
      // The modules that use it start again too: wait for every module to be running.
      await Promise.all(fibers.values());
    },
  };
}
