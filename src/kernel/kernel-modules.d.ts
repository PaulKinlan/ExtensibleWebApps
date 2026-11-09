// The kernel modules kernel.json lists, in order, made by the build (vite.kernel-modules.ts): each one's
// manifest, and the module itself or a way to fetch it.
declare module "virtual:kernel-modules" {
  const modules: import("./modules").ModuleEntry[];
  export default modules;
  /** The hook limits kernel.json sets (its `hooks`), checked by the build; the rest keep PLUGIN_HOOKS' defaults. */
  export const hookLimits: Partial<typeof import("./hooks").PLUGIN_HOOKS>;
}
