// Tells an agent file from a plugin by its address. A file of its own, apart from what reads which loop an agent
// runs (agent-runner.ts), because the kernel and the page ask this of every link they open, and only an app with
// an agent needs the rest: kept together, the reader was in every kernel's first file.

/** True for a link the kernel reads as an agent file rather than a plugin. */
export const isAgentFile = (href: string) => /\.agent\.md$/i.test(new URL(href, "http://x").pathname);
