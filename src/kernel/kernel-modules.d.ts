// The kernel modules kernel.json lists, in order, made by the build (vite.kernel-modules.ts).
declare module "virtual:kernel-modules" {
  const modules: import("./modules").KernelModule[];
  export default modules;
}
