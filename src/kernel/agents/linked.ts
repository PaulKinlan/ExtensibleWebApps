// An app's linked files as the plugin sources to run. A plugin's file is its source. An agent file
// (rel="agent", *.agent.md) becomes a plugin, made by the agent file reader (file.ts), which the kernel fetches
// only once an app links an agent: most apps link none, and their kernel never has it.
//
// The kernel calls `agentFiles` with an app's links before it reads them, so `asPlugin` can stay a plain
// function. An agent file read before then is an error, never passed through as if it were a plugin.

import { part } from "../part";
import { isAgentFile } from "../../shared/agent-file";

/** What the runner needs to know about its agent, fixed in its source. */
export interface AgentConfig {
  id: string;
  name: string;
  model?: string;
  instructions: string;
  hooks: string[];
  commands: string[];
  /** Whether it has an inbox on the bus (`- message: true`), and the bus topics it wakes on. */
  inbox: boolean;
  topics: string[];
  /** Hooks it is asked about before the action happens, and may block (`- check: <hook>`). */
  checks: string[];
  /** For a hook or check with `when`: a regular expression its value, as JSON, must match to wake the agent. */
  when: Record<string, string>;
  /** What happens to an action it couldn't check: in time, within its limits, or with an answer. */
  ifUnsure: "allow" | "block";
  /**
   * Who its changes are made as. `person`: in a run the person asked for (a message from a plugin, not
   * another agent, or a command), once they let it on a card, its changes are logged as theirs, made
   * through it. They are still reviewed, and it still may do only what its own permissions allow.
   */
  actsAs: "self" | "person";
  limits: { runsPerHour: number; tokensPerDay: number; steps: number };
}

/** Sources the kernel made from agent files, with what each one runs as: only these may call the agent methods. */
export const made = new Map<string, AgentConfig>();

let reader: typeof import("./file") | undefined;
let loading: Promise<void> | undefined;

/** Has the agent file reader ready if any of these links is an agent file. Settles at once when none is, or it already is. */
export function agentFiles(links: { href: string }[]): Promise<void> | undefined {
  if (reader || !links.some((link) => isAgentFile(link.href))) return undefined;
  return (loading ??= part("the agent file reader", () => import("./file")).then(
    (file) => void (reader = file),
    (error) => {
      loading = undefined;
      throw error;
    },
  ));
}

/** An agent file the person added, as the plugin to run and the loop it runs (file.ts ownAgent). The reader is fetched for it. */
export async function ownAgent(origin: string, file: string, text: string): Promise<{ source: string; runner: string }> {
  await agentFiles([{ href: file }]);
  return reader!.ownAgent(origin, text);
}

/**
 * A linked file as the plugin source to run: an agent file becomes a plugin, running the loop whose source
 * came with it (`runner`, fetched from runnerHref); anything else is left as it is.
 */
export function asPlugin(href: string, source: string, runner?: string): string {
  if (!isAgentFile(href)) return source;
  if (!reader) throw new Error("The agent file reader isn't ready: agentFiles(links) comes first");
  return reader.fromAgentFile(source, runner);
}
