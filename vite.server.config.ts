// The server's build: a space's kernel (src/server/space.ts) for Node, from
// the same kernel source as the browser's, and the sandbox each of its
// plugins runs in (src/server/isolate.ts, around src/sandbox/runtime.ts). Only the kernel needs building,
// because it imports plugin sources as text and finds services by name; the
// server itself (serve.ts) and the seams run as written. The output goes in
// .build/, which is never served.
import { kernelModules } from "./vite.kernel-modules";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  plugins: [kernelModules()],
  build: {
    ssr: true,
    outDir: ".build/server",
    emptyOutDir: true,
    target: "node22",
    rollupOptions: { input: { space: "src/server/space.ts", isolate: "src/server/isolate.ts" }, output: { entryFileNames: "[name].js" } },
  },
});
