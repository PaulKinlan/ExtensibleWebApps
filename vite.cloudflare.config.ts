// The Cloudflare build: a space's kernel (src/server/cloudflare/kernel.ts) as
// a few modules, which the Worker (src/server/cloudflare/worker.ts) loads as a
// Dynamic Worker for each space. It is written out as .build/cloudflare/
// kernel-source.js, the modules' text and a version from its hash, so the
// Worker can import it and Wrangler bundles it in. Never served.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

const asSource = (): Plugin => ({
  name: "kernel-source",
  generateBundle(_, bundle) {
    // The entry, and the kernel itself as a chunk of its own: the entry sets the environment, then imports it.
    const modules: Record<string, string> = {};
    for (const c of Object.values(bundle)) if (c.type === "chunk") modules[c.fileName] = c.code;
    if (!modules["kernel.js"]) throw new Error("No kernel entry was built");
    const version = createHash("sha256").update(JSON.stringify(modules)).digest("hex").slice(0, 12);
    mkdirSync(".build/cloudflare", { recursive: true });
    writeFileSync(".build/cloudflare/kernel-source.js", `// Built by npm run build:cloudflare from src/server/cloudflare/kernel.ts.\nexport default ${JSON.stringify({ version, main: "kernel.js", modules })};\n`);
  },
});

export default defineConfig({
  publicDir: false,
  plugins: [asSource()],
  ssr: { target: "webworker", noExternal: true },
  build: {
    ssr: "src/server/cloudflare/kernel.ts",
    outDir: ".build/cloudflare",
    emptyOutDir: false,
    target: "es2022",
    rollupOptions: { external: ["cloudflare:workers"], output: { entryFileNames: "kernel.js", chunkFileNames: "[name]-[hash].js", inlineDynamicImports: false } },
  },
});
