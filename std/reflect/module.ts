// The `reflect` service: the kernel describes what is running in it, for
// debuggers (demos/debugger/). Every plugin installed, its manifest, what it
// asked for and what it was given; every hook, who defined it and who listens;
// every worker and the tab it runs in; every tab and the app open there.
// A kernel module (docs/layers.md): a site that lists `reflect` in kernel.json has it, as `ctx.call("reflect", …)`.
//
// It only reads. It sees every app open in this kernel (every tab of this
// site, or of this space), not just the caller's, so it needs its own
// capability, `reflect:read`, which no app's plugins need unless they are a
// developer tool. It never returns a secret's value, only whether one is set.

import { capabilityFor, hooks } from "../../src/kernel/hooks";
import { startedAt } from "../../src/kernel/trace";
import { service, type ModuleKernel } from "../../src/kernel/modules";
import type { RemotePlugins, ServiceProvider } from "../../src/kernel/remote";

/** A hook's kind, by who defines it and so how long it lasts. */
type Kind = "kernel" | "plugin" | "collection";

/** Who defined a hook: the kernel, a plugin's manifest `hooks` (`<id>:<key>`), or a collection's owner. */
function ownerOf(name: string, remote: RemotePlugins): { kind: Kind; owner?: string } {
  const collection = /^data:(?:changed|beforeWrite):(.+)$/.exec(name)?.[1];
  if (collection) return { kind: "collection", owner: remote.collectionOwner?.(collection) };
  const colon = name.indexOf(":");
  if (colon > 0) {
    const id = name.slice(0, colon);
    // Read loosely: plugin-defined hooks are a manifest field (`hooks`) that older kernels don't type.
    const defined = (remote.installed.get(id)?.manifest as { hooks?: Record<string, unknown> } | undefined)?.hooks;
    if (defined && Object.hasOwn(defined, name.slice(colon + 1))) return { kind: "plugin", owner: id };
  }
  return { kind: "kernel" };
}

/**
 * What listening to a hook that isn't defined yet needs. A collection's hooks are known before their owner
 * arrives (data:changed:<c> only tells); a plugin's own hook's mode is in a manifest that isn't installed.
 */
function pendingCapability(name: string): string {
  if (name.startsWith("data:changed:")) return `hook:listen:${name}`;
  if (name.startsWith("data:beforeWrite:")) return `hook:intercept:${name}`;
  return `hook:listen:${name} or hook:intercept:${name}, by its mode`;
}

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { root, store, hosts, remote, apps } = kernel;
  const tabOf = (instance: string) => instance.split("@")[1];

  /** Every hook defined now, and every name some plugin listens to (it may be waiting for the hook to be defined). */
  const hookList = () => {
    const heard = new Map<string, string[]>();
    for (const [instance, r] of remote.live) for (const name of r.heard) heard.set(name, [...(heard.get(name) ?? []), instance]);
    const cordis = (root.events?._hooks ?? {}) as Record<string, unknown[]>;
    const names = new Set([...hooks.keys(), ...heard.keys()]);
    return [...names]
      // Commands, routes and scheduled jobs ride on hooks of their own per plugin (`command:…`, `route:…`,
      // `schedule:…`), which aren't public hooks: plugins() lists commands and routes.
      .filter((name) => !name.startsWith("internal/") && !(!hooks.has(name) && /^(command|route|schedule):/.test(name)))
      .sort((a, b) => a.localeCompare(b, "en"))
      .map((name) => {
        const spec = hooks.get(name);
        const listeners = (heard.get(name) ?? []).sort();
        return {
          name,
          // False for a name a plugin listens to before its plugin is installed: those listeners are waiting.
          defined: !!spec,
          ...ownerOf(name, remote),
          ...(spec ?? {}),
          listen: spec ? capabilityFor(name) : pendingCapability(name),
          listeners,
          // Listeners in the kernel itself (the kernel's own modules), beside the plugins' ones.
          inKernel: Math.max(0, (cordis[name]?.length ?? 0) - listeners.length),
        };
      });
  };

  const pluginList = async () => {
    // "Always allow" answers from review cards, per plugin and place, and which secrets are set (never their values).
    const [always, secrets] = await Promise.all([
      store.readJson<Record<string, string[]>>("grants.json", {}).catch(() => ({}) as Record<string, string[]>),
      store.readJson<Record<string, unknown>>("secrets.json", {}).catch(() => ({}) as Record<string, unknown>),
    ]);
    const tabs = hosts.list.map((h) => h.tab);
    return [...remote.installed.values()].map((p) => {
      const m = p.manifest as typeof p.manifest & { hooks?: Record<string, unknown> };
      const instances = remote.instances(p.id).map((instance) => {
        const r = remote.live.get(instance)!;
        return { instance, tab: tabOf(instance), runsIn: r.host.tab, heard: r.heard };
      });
      const heard = [...new Set(instances.flatMap((i) => i.heard))].sort();
      return {
        id: p.id,
        name: m.name,
        description: m.description ?? "",
        version: m.version,
        origin: p.origin,
        href: p.href,
        enabled: p.enabled,
        scope: m.scope ?? "shared",
        runs: m.runs ?? "browser",
        manifest: m,
        /** What the manifest asks for. */
        requested: [...m.permissions],
        /** What the gate grants, after editor permissions are mapped and implied ones added. */
        granted: [...p.caps].sort(),
        /** Places the person said this plugin may always change, from review cards. */
        always: Array.isArray(always[p.id]) ? always[p.id] : [],
        /** Each `secret:<name>` it holds, and whether the person has set that secret. */
        secrets: [...p.caps].filter((c) => c.startsWith("secret:")).map((c) => ({ name: c.slice(7), set: Object.hasOwn(secrets, c.slice(7)) })),
        /** The hooks it defines: its own (`<id>:<key>`) and its collections'. */
        defines: [...hooks.keys()].filter((name) => ownerOf(name, remote).owner === p.id).sort(),
        heard,
        routes: heard.filter((n) => n.startsWith("route:")).map((n) => n.slice(6)),
        commands: heard.filter((n) => n.startsWith("command:")).map((n) => n.slice(8)),
        instances,
        /** The tabs whose app links it. */
        linkedBy: tabs.filter((tab) => apps.linkedBy(tab)?.includes(p.id)),
      };
    });
  };

  const workerList = () =>
    [...remote.live.values()].map((r) => ({ instance: r.instance, plugin: r.plugin.id, scope: r.plugin.manifest.scope ?? "shared", runsIn: r.host.tab, tab: r.tab, hooks: r.heard.length }));

  /** Where a tab's app lives, from the plugins it links: the folder of the first that isn't a standard plugin. */
  const folderOf = (ids: string[] | undefined) => {
    const hrefs = (ids ?? []).flatMap((id) => remote.installed.get(id)?.href ?? []);
    const href = hrefs.find((h) => !new URL(h).pathname.startsWith("/std/")) ?? hrefs[0];
    return href ? new URL(".", href).pathname : undefined;
  };

  const tabList = () =>
    hosts.list.map((h) => ({
      tab: h.tab,
      app: apps.linkedBy(h.tab),
      folder: folderOf(apps.linkedBy(h.tab)),
      path: h.url?.path,
      spawner: h === hosts.spawner,
      member: h.member,
      workers: [...remote.live.values()].filter((r) => r.host === h).length,
    }));

  return {
    description: "What is running in the kernel, for debuggers: every plugin with its manifest and requested and granted permissions, every hook with its owner and listeners, every worker and every tab. Read only. It covers every app open in this kernel, so it needs `reflect:read`. Pair it with the `debug:trace` hook to see events as they fire.",
    methods: {
      snapshot: {
        args: "()",
        returns: "{ kernel, plugins, hooks, workers, tabs }",
        needs: "reflect:read",
        description: "All of it at once: what `plugins`, `hooks`, `workers` and `tabs` return, and `kernel`: { mode, startedAt }.",
      },
      plugins: {
        args: "()",
        returns: "[{ id, name, description, version, origin, href, enabled, scope, runs, manifest, requested, granted, always, secrets, defines, heard, routes, commands, instances: [{ instance, tab, runsIn, heard }], linkedBy }]",
        needs: "reflect:read",
        description: "Every plugin installed. `requested` is its manifest's permissions; `granted` the capabilities the gate holds it to; `always` the places the person let it change without asking; `secrets` each secret it may use and whether it is set; `defines` the hooks it owns; `heard` the hooks it listens to; `linkedBy` the tabs whose app links it.",
      },
      hooks: {
        args: "()",
        returns: "[{ name, defined, kind, owner?, mode?, timeoutMs?, onFailure?, args?, description?, listen, listeners, inKernel }]",
        needs: "reflect:read",
        description: "Every hook, and every name a plugin listens to before it is defined. `kind` is kernel, plugin (from a manifest's `hooks`) or collection; `owner` the plugin that defines it; `listen` the capability listening needs; `listeners` the plugin instances listening; `inKernel` how many of the kernel's own modules listen.",
      },
      workers: {
        args: "()",
        returns: "[{ instance, plugin, scope, runsIn, tab?, hooks }]",
        needs: "reflect:read",
        description: "Every plugin worker running: the instance, the tab that started its worker (`runsIn`), the tab it serves if it is tab-scoped, and how many hooks it listens to.",
      },
      tabs: {
        args: "()",
        returns: "[{ tab, app?, folder?, path?, spawner, member?, workers }]",
        needs: "reflect:read",
        description: "Every open tab: the folder its app is in (from the plugins it links), the screen it shows within the app (`path`), whether it starts the shared plugins' workers (`spawner`), the plugins its app links (none for a page that opened no app), and how many workers run in it.",
      },
      source: {
        args: "(id)",
        returns: "string",
        needs: "reflect:read",
        description: "A plugin's code, as installed.",
      },
    },
    capability: () => "reflect:read",
    call: async (_instance, method, args) => {
      if (method === "plugins") return pluginList();
      if (method === "hooks") return hookList();
      if (method === "workers") return workerList();
      if (method === "tabs") return tabList();
      if (method === "snapshot") {
        return { kernel: { mode: hosts.mode, startedAt }, plugins: await pluginList(), hooks: hookList(), workers: workerList(), tabs: tabList() };
      }
      if (method === "source") {
        const plugin = remote.installed.get(String(args[0]));
        if (!plugin) throw new Error(`No plugin ${String(args[0])} is installed`);
        return plugin.source;
      }
      throw new Error(`reflect.${method} is not a method`);
    },
  };
};

export default service("reflect", make);
