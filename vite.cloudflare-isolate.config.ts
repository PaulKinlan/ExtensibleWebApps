// The Cloudflare build of a plugin's sandbox (src/server/cloudflare/isolate.ts):
// its modules as text, written out as .build/cloudflare/isolate-source.js for
// the Worker to import. The Worker loads them as a Dynamic Worker for each
// server plugin of a space, with the plugin's own source beside them as
// plugin.js. Never served.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

const asSource = (): Plugin => ({
  name: "isolate-source",
  generateBundle(_, bundle) {
    const modules: Record<string, string> = {};
    for (const c of Object.values(bundle)) if (c.type === "chunk") modules[c.fileName] = c.code;
    if (!modules["isolate.js"]) throw new Error("No isolate entry was built");
    const version = createHash("sha256").update(JSON.stringify(modules)).digest("hex").slice(0, 12);
    mkdirSync(".build/cloudflare", { recursive: true });
    writeFileSync(".build/cloudflare/isolate-source.js", `// Built by npm run build:cloudflare from src/server/cloudflare/isolate.ts.\nexport default ${JSON.stringify({ version, main: "isolate.js", modules })};\n`);
  },
});

export default defineConfig({
  publicDir: false,
  logLevel: "warn",
  plugins: [asSource()],
  ssr: { target: "webworker", noExternal: true },
  build: {
    ssr: "src/server/cloudflare/isolate.ts",
    outDir: ".build/cloudflare-isolate",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { external: ["cloudflare:workers"], output: { entryFileNames: "isolate.js", chunkFileNames: "[name]-[hash].js", inlineDynamicImports: false } },
  },
});
