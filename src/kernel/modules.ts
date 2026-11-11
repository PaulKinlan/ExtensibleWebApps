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
//
// A module is not part of the kernel's file, and doesn't run, until it is
// used. Beside each is its manifest, std/<name>/module.json, which says what
// it adds without running it:
//
//   { "services": ["router"], "hooks": ["router:changed"] }
//
// (and `commands`, `messages`, `doors`, and `starts`). The kernel starts with
// the manifests only. It fetches and starts a module the first time something
// it adds is used: a plugin that lists its service in `services` is installed,
// a plugin calls its service or listens to its hook, the page runs its
// command or sends its message. A module that must run from the start says
// `"starts": "always"`, `"space"` for a kernel that is for a space, or
// `"account"` for a kernel on a device where the person is signed in. A
// space's server starts them all. So an app's kernel is the core plus the
// modules that app uses, and a module nothing uses costs nothing.
//
// A manifest is held to: a module that adds a service, hook, command, message
// or door its manifest doesn't list fails to start, and
// tests/checks/module-manifests.mjs fails for one that lists what it never adds.

import { part } from "./part";
import type { Kernel } from "./services/index";
import type { Sharing } from "./authoring";
import type { Host } from "./hosts";
import type { ServiceProvider } from "./remote";
import type { RouteRequest, RouteResponse } from "./routes";
import { RESERVED } from "./manifest";
import { declaredHooks, defineHook, type HookSpec } from "./hooks";
import { record } from "./trace";

/**
 * The mark the account module (std/account) leaves in the data folder while the person is signed in to the site on
 * this device: a session cookie can't be seen from here, and asking the server as every app opens would cost
 * everyone who isn't signed in a request.
 */
export const SIGNED_IN = "sync/signed-in.json";

/** The Cordis service a module's service is also registered as, so other modules can `inject` it. */
const cordisName = (name: string) => `kernel.${name}`;

/** An app a member made and shared with the space, as a device sees it (std/spaces/made-apps.ts). */
export interface SharedMadeApp {
  name: string;
  title: string;
  hash: string;
  files: string[];
  /** The member who shared it, or last changed it: their id, and their name if the space said. */
  by?: string;
  byName?: string;
  at: string;
}

/** In a browser kernel for a space: the apps its members made and shared (std/spaces/made-apps.ts), for the maker module. */
export interface MadeAppsSeam {
  /** The space's shared apps; undefined if the space can't be reached. */
  list(): Promise<SharedMadeApp[] | undefined>;
  get(name: string): Promise<{ ok: true; files: { name: string; text: string }[]; hash: string } | { ok: false; error: string }>;
  share(name: string, files: { name: string; text: string }[]): Promise<{ ok: true; hash: string } | { ok: false; error: string }>;
  unshare(name: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Heard whenever the list may have changed: a member shared, changed or stopped sharing one, or the device caught up. */
  changed: Set<() => void>;
}

/**
 * What the spaces module (std/spaces/module.ts) lends the core while it runs. The core asks it, and never
 * names it: a kernel without it keeps no space.
 */
export interface SpaceSeam {
  /** In a browser kernel for a space: settles once a device new to the space has what the space has, so an app opening sees it. */
  ready?(): Promise<void>;
  /** In a browser kernel for a space: an app opened here, so the space starts its plugins that run on the server. */
  use?(app: string): void;
  /** In a browser kernel for a space: sharing the person's own plugins with its members (Customize, authoring). */
  sharing?: Sharing;
  /** In a browser kernel for a space: the apps its members made and shared with it, for the maker module. */
  madeApps?: MadeAppsSeam;
  /** On a space's server: its apps' server plugins starting, so a request for a route one adds waits for them; and the apps opened in the space (`list`). */
  server?: { starting(): boolean; settled(): Promise<unknown>; finishedAt(): number; list?(): Promise<string[]> };
  /**
   * On a space's server: asks the model the space holds a key for (std/spaces/model-key.ts), as its `model` door
   * does, for a module that was itself let in by the host with what unlocks the key (std/acp).
   */
  model?(request: RouteRequest): Promise<RouteResponse>;
}

/** Where a module's messages and space seam go in the core (loadModules). */
export interface Seams {
  /** Host messages by type (`sync`), and the module that answers each. */
  messages: Map<string, (host: Host, message: any) => unknown>;
  /** The space seam, while a module lends one. */
  space: { current?: SpaceSeam };
}

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
  /** Answers the messages of one type a page or device sends the kernel (`sync`: a device's sync with its space). */
  message(type: string, handle: (host: Host, message: any) => unknown): void;
  /** Lends the core what a space adds (SpaceSeam). One module at a time. */
  space(seam: SpaceSeam): void;
  /** What a module lends as the space seam now, if any: how another module (maker) reaches the space. */
  lent(): SpaceSeam | undefined;
}

/** A module: a Cordis plugin the kernel runs with its parts as the config. */
export interface KernelModule {
  name: string;
  /** Other modules it needs, by name. The kernel refuses to start without them. */
  uses?: string[];
  apply(ctx: any, kernel: ModuleKernel): void;
}

/** What a module's manifest (std/<name>/module.json) says it adds, and when it starts by itself. The build checks its shape (vite.kernel-modules.ts). */
export interface ModuleManifest {
  services?: string[];
  hooks?: string[];
  commands?: string[];
  messages?: string[];
  doors?: string[];
  /**
   * Starts with every kernel ("always"), with a kernel that is for a space ("space"), or with a kernel on a device
   * where the person is signed in to the site ("account"). Without it, when first used.
   */
  starts?: "always" | "space" | "account";
}

/** A module as the build hands it to the kernel: its manifest, and the module itself (a server's kernel) or how to fetch it (the browser's). */
export interface ModuleEntry {
  name: string;
  manifest: ModuleManifest;
  module?: KernelModule;
  load?: () => Promise<KernelModule>;
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
 * Knows each module by its manifest, and runs one as a Cordis plugin on the kernel's root context when it is
 * first used (or at once: `eager`, a server's kernel, and the modules whose manifests say they start with this
 * kernel). Services, commands and hooks a module adds go into the kernel's tables as Cordis effects, so they
 * come out again when the module is disposed. Until a module runs, each service its manifest lists has a
 * stand-in in the table whose `load` starts it, and each hook is in `declaredHooks`.
 */
export function loadModules(
  entries: ModuleEntry[],
  kernel: Kernel,
  services: Record<string, ServiceProvider>,
  commands: Map<string, (arg: unknown) => unknown>,
  /** The doors modules answer (ModuleKernel.door), by name. */
  doors: Map<string, (request: RouteRequest) => Promise<RouteResponse | null> | RouteResponse | null>,
  /** The kernel's own page commands, which a module may not take. */
  coreCommand: (name: string) => boolean,
  /** Where messages and the space seam go. */
  seams: Seams = { messages: new Map(), space: {} },
  options: {
    /** Start every module now (a space's server), rather than each when first used. */
    eager?: boolean;
    /** Whether this kernel is for a space: the modules that say `"starts": "space"` start with it. */
    space?: boolean;
    /** Whether someone is signed in to the site on this device: the modules that say `"starts": "account"` start once it says so. */
    account?: () => Promise<boolean>;
    /** Told when a module started after the kernel did, so the core can tell it what it missed (the tabs' addresses). */
    onLate?: (name: string) => void;
  } = {},
) {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  /** The module that says it adds each thing, by kind and name. */
  const owners = { services: new Map<string, string>(), hooks: new Map<string, string>(), commands: new Map<string, string>(), messages: new Map<string, string>(), doors: new Map<string, string>() };
  for (const { name, manifest } of entries) {
    for (const kind of Object.keys(owners) as (keyof typeof owners)[])
      for (const added of manifest[kind] ?? []) {
        if (owners[kind].has(added)) throw new Error(`The ${name} and ${owners[kind].get(added)} modules both say they add ${added}`);
        owners[kind].set(added, name);
      }
    for (const command of manifest.commands ?? []) if (coreCommand(command)) throw new Error(`The ${name} module can't add the command ${command}: it is the kernel's`);
  }
  /** What each module has added since the kernel started, as `kind name`: its manifest is checked against it (`state`). */
  const added = new Map<string, Set<string>>();
  /** Checked as a module adds something: its manifest must list it, so the kernel knew before the module ran. */
  const listed = (module: string, kind: keyof typeof owners, name: string) => {
    if (owners[kind].get(name) !== module) throw new Error(`The ${module} module adds ${name}, which std/${module}/module.json doesn't list under ${kind}`);
    added.set(module, (added.get(module) ?? new Set()).add(`${kind} ${name}`));
  };

  /** Each module's fiber once it runs, and the start that is under way or done. */
  const fibers = new Map<string, any>();
  const starts = new Map<string, Promise<void>>();
  const plugins = new Map<string, { name: string; inject: string[]; apply(ctx: any): void }>();
  let late = false;

  /** A service's stand-in until its module runs: it has no methods of its own, and `load` starts the module. */
  const standIn = (module: string, name: string): ServiceProvider => ({
    description: "",
    methods: {},
    capability: () => undefined,
    call: () => {
      throw new Error(`The ${name} service isn't running yet`);
    },
    load: () => start(module),
  });
  const await_ = (module: string) => () => start(module);
  /** Puts back what says a module is there but not running: its services' stand-ins and its hooks' names. */
  const declare = ({ name, manifest }: ModuleEntry) => {
    for (const service of manifest.services ?? []) {
      RESERVED.add(service);
      if (!Object.hasOwn(services, service)) services[service] = standIn(name, service);
    }
    for (const hook of manifest.hooks ?? []) declaredHooks.set(hook, await_(name));
  };

  const pluginFor = (module: KernelModule) => ({
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
          listed(module.name, "services", name);
          if (Object.hasOwn(services, name) && !services[name].load) throw new Error(`The ${module.name} module can't provide ${name}: the kernel already has a service by that name`);
          RESERVED.add(name);
          ctx.effect(() => {
            services[name] = provider;
            // Stopped, it is as it was before it ran: there, and started by whoever uses it next.
            return () => void (services[name] = standIn(module.name, name));
          }, `service ${name}`);
          ctx.provide(cordisName(name), provider);
        },
        command(name, run) {
          listed(module.name, "commands", name);
          if (commands.has(name)) throw new Error(`The ${module.name} module can't add the command ${name}: it is taken`);
          ctx.effect(() => {
            commands.set(name, run);
            return () => void commands.delete(name);
          }, `command ${name}`);
        },
        door(name, answer) {
          listed(module.name, "doors", name);
          if (doors.has(name)) throw new Error(`The ${module.name} module can't answer the door ${name}: another module does`);
          ctx.effect(() => {
            doors.set(name, answer);
            return () => void doors.delete(name);
          }, `door ${name}`);
        },
        hook(name, spec) {
          listed(module.name, "hooks", name);
          ctx.effect(() => {
            const off = defineHook(name, spec);
            declaredHooks.delete(name);
            return () => {
              off();
              declaredHooks.set(name, await_(module.name));
            };
          }, `hook ${name}`);
        },
        cleanup(fn) {
          ctx.effect(() => fn, "cleanup");
        },
        message(type, handle) {
          listed(module.name, "messages", type);
          if (seams.messages.has(type)) throw new Error(`The ${module.name} module can't answer ${type} messages: another module does`);
          ctx.effect(() => {
            seams.messages.set(type, handle);
            return () => void seams.messages.delete(type);
          }, `message ${type}`);
        },
        lent: () => seams.space.current,
        space(seam) {
          if (seams.space.current) throw new Error(`The ${module.name} module can't lend a space: another module does`);
          ctx.effect(() => {
            seams.space.current = seam;
            return () => void (seams.space.current = undefined);
          }, "space");
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
  });

  /** Hands a module to Cordis, which applies it once the modules it uses are running. The module must be the one its folder names. */
  const run = (entry: ModuleEntry, module: KernelModule) => {
    if (module.name !== entry.name) throw new Error(`std/${entry.name}/module.ts is named ${module.name}`);
    const missing = (module.uses ?? []).filter((name) => !byName.has(name));
    if (missing.length) throw new Error(`The ${module.name} module needs ${missing.join(", ")}, which kernel.json doesn't list`);
    const plugin = pluginFor(module);
    plugins.set(entry.name, plugin);
    const fiber = kernel.root.plugin(plugin);
    fibers.set(entry.name, fiber);
    return { fiber, uses: module.uses ?? [] };
  };

  /**
   * Starts a module (once: later calls wait on the same start), and the modules it uses with it. A module that
   * can't be fetched or fails to start is an error in the trace, the services it would give stay stand-ins, and
   * the next use tries again.
   */
  function start(name: string): Promise<void> {
    const running = starts.get(name);
    if (running) return running;
    const entry = byName.get(name);
    if (!entry) return Promise.reject(new Error(`No module ${name}`));
    const starting = (async () => {
      const module = entry.module ?? (await part(`the ${name} module`, entry.load!));
      const { fiber, uses } = run(entry, module);
      await Promise.all(uses.map(start));
      await fiber;
      if (late) options.onLate?.(name);
    })().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      record({ kind: "error", name: "module:failed", plugin: name, detail });
      // Whatever it had added is taken back, and it can be tried again.
      void Promise.resolve(fibers.get(name)?.dispose?.()).catch(() => {});
      fibers.delete(name);
      plugins.delete(name);
      starts.delete(name);
      throw new Error(`The ${name} module didn't start: ${detail}`);
    });
    starts.set(name, starting);
    return starting;
  }

  for (const entry of entries) declare(entry);
  // The modules that start with this kernel. On a server (eager) each is part of the kernel's file, and is handed
  // to Cordis here and now, in kernel.json's order, as modules always were.
  const first = entries.filter((entry) => options.eager || entry.manifest.starts === "always" || (entry.manifest.starts === "space" && options.space));
  for (const entry of first) {
    if (!entry.module) continue;
    // A module that uses one the site doesn't list stops the kernel here, as it always has.
    const { fiber } = run(entry, entry.module);
    starts.set(
      entry.name,
      Promise.resolve(fiber).then(
        () => {},
        (error: unknown) => {
          record({ kind: "error", name: "module:failed", plugin: entry.name, detail: error instanceof Error ? error.message : String(error) });
          throw error;
        },
      ),
    );
  }
  const ready = Promise.all(first.map((entry) => start(entry.name).catch(() => {}))).then(() => {
    late = true;
  });
  /**
   * The modules that start once someone is signed in. Nothing waits for them: an app opens with what the device
   * has, and they bring the rest. Asked again when the person signs in (kernel.ts).
   */
  const account = () =>
    void options.account?.().then((signedIn) => {
      if (signedIn) for (const entry of entries) if (entry.manifest.starts === "account") start(entry.name).catch(() => {});
    });
  if (!options.eager) account();
  /** Starts the module that says it adds this, if it isn't running. Resolves false if no module adds it. */
  const need = (kind: keyof typeof owners) => (name: string): Promise<boolean> | undefined => {
    const owner = owners[kind].get(name);
    return owner === undefined ? undefined : start(owner).then(() => true);
  };
  return {
    /** Settles once every module that starts with the kernel has started or failed. */
    ready,
    account,
    /** Starts every module the site lists: for what describes the whole kernel (its reference, an agent's tools). Ones that fail are in the trace. */
    all: () => Promise.all(entries.map((entry) => start(entry.name).catch(() => {}))).then(() => {}),
    /** Starts the module that adds a page command, a message type or a door, if one says it does: undefined if none does. */
    command: need("commands"),
    message: need("messages"),
    door: need("doors"),
    /**
     * Each module the site lists: whether it is running, and what its manifest lists that it hasn't added in this
     * kernel (`unused`, as `kind name`). A manifest that lists what its module never adds is wrong: the kernel
     * would start the module for nothing, and say a service or hook is there that isn't.
     */
    state: () =>
      entries.map(({ name, manifest }) => ({
        name,
        running: fibers.has(name),
        unused: (Object.keys(owners) as (keyof typeof owners)[]).flatMap((kind) => (manifest[kind] ?? []).map((n) => `${kind} ${n}`)).filter((n) => !added.get(name)?.has(n)),
      })),
    /** Stops a module, and the modules that use it, then starts it again; they start again with it. One that wasn't running is started. */
    async restart(name: string) {
      if (!byName.has(name)) throw new Error(`No module ${name}`);
      await start(name);
      const plugin = plugins.get(name)!;
      await fibers.get(name).dispose();
      fibers.set(name, kernel.root.plugin(plugin));
      // The modules that use it start again too: wait for every running module.
      await Promise.all(fibers.values());
    },
  };
}
