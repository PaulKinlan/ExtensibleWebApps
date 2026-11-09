// Builds vendor/codemirror/codemirror.js: CodeMirror 6, the parts <ui-editor>
// uses, as one ES module the browser loads as written. It is the only file in
// the repo that is built, and it is built once, here, and committed, like
// vendor/mermaid/: apps and elements still have no build step.
//
//   node scripts/vendor-codemirror.mjs
//
// It installs the versions below into a temporary folder (nothing is added to
// package.json), bundles ENTRY with esbuild (which Vite already brings), and
// writes the bundle and the licence. Change a version here and run it again
// to update; vendor/codemirror/README.md says which versions are in it.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const PACKAGES = {
  "@codemirror/commands": "6.8.1",
  "@codemirror/lang-markdown": "6.3.2",
  "@codemirror/language": "6.11.0",
  "@codemirror/search": "6.5.10",
  "@codemirror/state": "6.5.2",
  "@codemirror/view": "6.36.8",
  "@lezer/highlight": "1.2.1",
};

// What <ui-editor> imports. Anything else it needs is added here and built again.
const ENTRY = `
export { EditorState, StateEffect, StateField, Compartment, EditorSelection } from "@codemirror/state";
export { EditorView, Decoration, keymap, placeholder, drawSelection, highlightActiveLine, ViewPlugin, MatchDecorator } from "@codemirror/view";
export { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
export { syntaxHighlighting, HighlightStyle, defaultHighlightStyle } from "@codemirror/language";
export { markdown, markdownLanguage } from "@codemirror/lang-markdown";
export { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
export { tags } from "@lezer/highlight";
`;

const out = fileURLToPath(new URL("../vendor/codemirror/", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "codemirror-"));
try {
  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent", ...Object.entries(PACKAGES).map(([name, version]) => `${name}@${version}`)], { cwd: temp, stdio: "inherit" });
  writeFileSync(join(temp, "entry.js"), ENTRY);
  await build({
    entryPoints: [join(temp, "entry.js")],
    bundle: true,
    format: "esm",
    minify: true,
    target: "es2022",
    legalComments: "none",
    outfile: join(out, "codemirror.js"),
    banner: { js: `// CodeMirror 6 (MIT licence, see LICENSE), bundled by scripts/vendor-codemirror.mjs from ${Object.entries(PACKAGES).map(([n, v]) => `${n}@${v}`).join(", ")}.` },
  });
  writeFileSync(join(out, "LICENSE"), readFileSync(join(temp, "node_modules/@codemirror/state/LICENSE")));
  const installed = Object.keys(PACKAGES).map((name) => `${name}@${JSON.parse(readFileSync(join(temp, "node_modules", name, "package.json"), "utf8")).version}`);
  console.log(`Wrote vendor/codemirror/codemirror.js from ${installed.join(", ")}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
