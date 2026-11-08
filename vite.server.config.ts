// The server's build: a space's kernel (src/server/space.ts) for Node, from
// the same kernel source as the browser's. Only the kernel needs building,
// because it imports plugin sources as text and finds services by name; the
// server itself (serve.ts) and the seams run as written. The output goes in
// .build/, which is never served.
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    ssr: "src/server/space.ts",
    outDir: ".build/server",
    emptyOutDir: true,
    target: "node22",
    rollupOptions: { output: { entryFileNames: "space.js" } },
  },
});
