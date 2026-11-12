// Which agent loop an agent file runs. The loop is a file the site serves, not
// part of the kernel: the standard one is std/agents/runner.js, and an agent
// may name another in its frontmatter (`runner: ./plan-then-act.js`), relative
// to the agent file. Whoever reads the app's links (the host in a tab,
// scripts/check.mjs on disk) fetches it next to the agent file, and the kernel
// puts it after the manifest it makes (src/kernel/agents/file.ts), so a
// different loop is still held to the agent's own manifest.

/** The loop an agent runs when its file names none. */
export const DEFAULT_RUNNER = "/std/agents/runner.js";

// (Whether a link is an agent file at all is agent-file.ts, which everything that opens links uses. This file
// imports nothing: the page's script fetches it while it is still starting, and a file that imported from the
// page's script would wait for it to finish, which waits for this.)

/** What an agent file's frontmatter names as its loop (`runner:`), as written, or undefined. The kernel checks the rest of the file. */
export function runnerName(text: string): string | undefined {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const end = lines[0]?.trim() === "---" ? lines.indexOf("---", 1) : -1;
  const body = end > 0 ? lines.slice(1, end) : [];
  // Top-level keys sit at the first key's indent (the kernel's reader allows the block to be indented).
  const first = body.find((l) => l.trim() && !l.trim().startsWith("#"));
  const indent = first ? first.length - first.trimStart().length : 0;
  const line = body.find((l) => l.length - l.trimStart().length === indent && /^runner\s*:/.test(l.trimStart()));
  return line?.trimStart().replace(/^runner\s*:\s*/, "").replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2") || undefined;
}

/** The address of the loop an agent file runs: its `runner:`, resolved against the file, or the standard one. */
export function runnerHref(text: string, agentHref: string): string {
  return new URL(runnerName(text) ?? DEFAULT_RUNNER, agentHref).href;
}
