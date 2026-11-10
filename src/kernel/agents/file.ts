// Agent files. An agent is a Markdown file an app links next to its plugins:
//
//   <link rel="agent" href="agents/shelf-tagger.agent.md">
//
// Its frontmatter says who it is, what it may do and what wakes it; the
// Markdown after it is its instructions, which become the model's system
// prompt. The kernel turns the file into an ordinary plugin before it runs:
// a manifest made from the frontmatter, then the agent loop. The loop is a
// file the site serves (std/agents/runner.js, or the one the frontmatter's
// `runner:` names; src/shared/agent-runner.ts), fetched next to the agent
// file, so a different loop needs no change to the kernel. Either way an
// agent is held to its manifest by the same gate as any plugin, and the
// person sees what it may do the same way.
//
//   ---
//   id: shelf-tagger
//   name: Shelf tagger
//   permissions: [data:read:library, data:write:library]
//   on:
//     - hook: data:changed:library
//     - command: tag-untagged-books
//     - message: true          (an inbox: others may send it messages)
//     - topic: new-books       (a bus topic it wakes on)
//     - check: data:beforeWrite:library    (asked before a write, which it may block)
//       when: '\d{13,19}'                 (only if the value, as JSON, matches)
//   if-unsure: block                      (block what it couldn't check)
//   acts-as: person                       (it may act for the person, once they let it)
//   limits: { runs-per-hour: 30, tokens-per-day: 200000 }
//   runner: ./plan-then-act.js            (another loop; std/agents/runner.js if left out)
//   ---
//   You keep the reading list tidy. When a book has no genre, ...
//
// The frontmatter is a small part of YAML: `key: value`, lists as `[a, b]` or
// as `- item` lines, and maps as `{ a: 1 }` or indented lines.
//
// An agent that lives outside the app (the browser's own assistant, Claude
// Code, any MCP client) is described the same way, with `outside: true`: the
// file says what outside agents may do and, after the frontmatter, what the
// app is for. The kernel makes it the plugin that opens the door to them
// (std/outside/module.ts), in the browser and on a space's server, with no
// model or loop of its own:
//
//   ---
//   id: reading-list-agents
//   name: Outside agent
//   outside: true
//   permissions: [data:read:library, data:write:library]
//   ---
//   This is a reading list. ...

import { grants } from "../gate";
import { DEFAULT_RUNNER, isAgentFile, runnerName } from "../../shared/agent-runner";
import { made } from "./linked";

export { isAgentFile };

export class AgentFileError extends Error {}

/** The site's standard agent loop, read once: what an agent of the person's runs. */
let loop: Promise<string> | undefined;

/**
 * An agent file a person added to an app themselves (user-plugins.ts), as the plugin to run and the loop it
 * runs. It runs the site's standard loop, and is no door for outside agents: both are an app author's to choose.
 */
export async function ownAgent(origin: string, text: string): Promise<{ source: string; runner: string }> {
  if (runnerName(text)) throw new AgentFileError("An agent you add runs the standard agent loop: take out its `runner:` line");
  if (split(text).meta.outside !== undefined) throw new AgentFileError("An agent you add can't be a door for outside agents (`outside:`): that is the app's to link");
  loop ??= fetch(`${origin}${DEFAULT_RUNNER}`).then((response) => {
    if (!response.ok) throw new Error(`The agent loop ${DEFAULT_RUNNER} answered ${response.status}`);
    return response.text();
  });
  const runner = await loop.catch((error) => {
    loop = undefined;
    throw error;
  });
  return { source: fromAgentFile(text, runner), runner };
}

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

/** Paul's defaults (2026-11-07): 30 runs an hour and 200,000 tokens a day; 12 model turns a run. */
export const DEFAULT_LIMITS = { runsPerHour: 30, tokensPerDay: 200_000, steps: 12 };

const KEYS = new Set(["id", "name", "description", "version", "model", "acts-as", "permissions", "on", "limits", "if-unsure", "runner"]);
const LIMITS: Record<string, keyof AgentConfig["limits"]> = { "runs-per-hour": "runsPerHour", "tokens-per-day": "tokensPerDay", steps: "steps" };
const LATER: Record<string, string> = {
  emits: "Agents emit only the agent:* events for now",
  uses: "A companion plugin (`uses`) comes later; link it with rel=\"plugin\" for now",
};
const COMMAND = /^[a-z][a-z0-9-]{0,63}$/;

// Kept in linked.ts, which the kernel has from the start: a plugin's source is looked up there on every agent call.
export { made };

/**
 * Turns an agent file into a plugin's source, running `runner`, the agent loop's source. Throws an
 * AgentFileError that says what is wrong with the file, or that its loop didn't come with it: an agent
 * never falls back to another loop than the one it names.
 */
export function fromAgentFile(text: string, runner?: string): string {
  const { meta, body } = split(text);
  if (meta.outside !== undefined) return fromOutsideFile(meta, body);
  for (const key of Object.keys(meta)) {
    if (LATER[key]) throw new AgentFileError(`${LATER[key]}.`);
    if (!KEYS.has(key)) throw new AgentFileError(`The frontmatter has no field \`${key}\``);
  }
  const string = (key: string) => {
    const v = meta[key];
    if (v !== undefined && typeof v !== "string") throw new AgentFileError(`\`${key}\` must be text`);
    return v as string | undefined;
  };
  const id = string("id");
  const name = string("name");
  if (!id) throw new AgentFileError("An agent needs an `id`");
  if (!name) throw new AgentFileError("An agent needs a `name`");
  const actsAs = string("acts-as") ?? "self";
  if (actsAs !== "self" && actsAs !== "person") throw new AgentFileError("`acts-as` is self or person");

  const permissions = meta.permissions ?? [];
  if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== "string")) throw new AgentFileError("`permissions` must be a list");

  const hooks: string[] = [];
  const commands: string[] = [];
  const topics: string[] = [];
  const checks: string[] = [];
  const when: Record<string, string> = Object.create(null);
  let inbox = false;
  const on = meta.on ?? [];
  if (!Array.isArray(on)) throw new AgentFileError("`on` must be a list of what wakes the agent");
  for (const trigger of on) {
    const entry = trigger && typeof trigger === "object" && !Array.isArray(trigger) ? (trigger as Record<string, unknown>) : {};
    const [kind, value] = Object.entries(entry)[0] ?? [];
    const extra = Object.keys(entry).slice(1);
    if (extra.length && !(extra.length === 1 && extra[0] === "when" && (kind === "hook" || kind === "check"))) throw new AgentFileError("Only a `hook` or `check` entry in `on` may say more, and only `when: <pattern>`");
    if (kind === "hook" && typeof value === "string" && value) hooks.push(value);
    else if (kind === "check" && typeof value === "string" && value) checks.push(value);
    else if (kind === "command" && typeof value === "string" && COMMAND.test(value)) commands.push(value);
    else if (kind === "message" && value === true) inbox = true;
    else if (kind === "topic" && typeof value === "string" && COMMAND.test(value)) topics.push(value);
    else throw new AgentFileError("Each entry in `on` is `- hook: <name>`, `- check: <name>`, `- command: <name>`, `- message: true` or `- topic: <name>` (names are lowercase letters, digits and dashes)");
    if (extra.length) {
      const pattern = entry.when;
      if (typeof pattern !== "string" || !pattern) throw new AgentFileError("`when` must be a pattern, in quotes");
      try {
        new RegExp(pattern);
      } catch {
        throw new AgentFileError(`\`when: ${pattern}\` isn't a pattern JavaScript can read`);
      }
      when[value as string] = pattern;
    }
  }
  if (hooks.some((h) => checks.includes(h))) throw new AgentFileError("A hook can wake an agent as a `hook` or a `check`, not both");
  const unsure = meta["if-unsure"] ?? "allow";
  if (unsure !== "allow" && unsure !== "block") throw new AgentFileError("`if-unsure` is allow or block");

  // An agent can't own a collection, so hearing that one changed needs reading it.
  // Checked against every permission, as the gate would: data:* or * grants data:read:x too.
  const granted = new Set(permissions as string[]);
  for (const hook of hooks) {
    const collection = /^data:changed:(.+)$/.exec(hook)?.[1];
    if (collection && !grants(granted, `data:read:${collection}`)) throw new AgentFileError(`Waking on ${hook} needs data:read:${collection} in \`permissions\``);
  }
  // Checking a write is reading what would be written.
  for (const hook of checks) {
    const collection = /^data:beforeWrite:(.+)$/.exec(hook)?.[1];
    if (collection && !grants(granted, `data:read:${collection}`)) throw new AgentFileError(`Checking ${hook} needs data:read:${collection} in \`permissions\``);
  }

  // Waking on a topic needs reading it, as a reader would.
  for (const topic of topics) if (!grants(granted, `bus:read:${topic}`)) throw new AgentFileError(`Waking on the topic ${topic} needs bus:read:${topic} in \`permissions\``);

  const limits = { ...DEFAULT_LIMITS };
  const given = meta.limits ?? {};
  if (!given || typeof given !== "object" || Array.isArray(given)) throw new AgentFileError("`limits` must be a map");
  for (const [key, value] of Object.entries(given)) {
    const field = LIMITS[key];
    if (!field) throw new AgentFileError(`\`limits\` has no \`${key}\`: use runs-per-hour, tokens-per-day or steps`);
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new AgentFileError(`\`limits.${key}\` must be a whole number above 0`);
    limits[field] = value;
  }

  const named = meta.runner;
  if (named !== undefined && (typeof named !== "string" || !named)) throw new AgentFileError("`runner` must be the address of the agent loop to run, such as ./my-loop.js");
  if (!runner?.trim()) throw new AgentFileError(`Its agent loop (${typeof named === "string" ? named : "/std/agents/runner.js"}) didn't load`);

  const instructions = body.trim();
  if (!instructions) throw new AgentFileError("An agent needs instructions: write them after the frontmatter");
  const model = string("model");
  const config: AgentConfig = { id, name, model: model && model !== "default" ? model : undefined, instructions, hooks, commands, inbox, topics, checks, when, ifUnsure: unsure, actsAs, limits };

  // An agent asks the model (llm), is an agent (agent: it hears requests to run), listens to the hooks that wake it,
  // and, with `- message: true`, has an inbox; waking on a topic means hearing that something was posted.
  // A check intercepts its hook: it may stop the action.
  const caps = [
    ...permissions,
    "llm",
    "agent",
    ...hooks.filter((h) => !h.startsWith("data:changed:")).map((h) => `hook:listen:${h}`),
    ...(inbox ? ["bus:inbox"] : []),
    ...(topics.length ? ["hook:listen:bus:posted"] : []),
    ...checks.map((h) => `hook:intercept:${h}`),
  ];
  const manifest = {
    id,
    name,
    description: string("description") ?? `An agent: ${instructions.split("\n")[0].slice(0, 200)}`,
    version: string("version") ?? "1.0.0",
    permissions: [...new Set(caps)],
    // The standard loop calls these (std/agents/runner.js), so an app with an agent fails to open on a site that doesn't run them.
    services: ["agents", "bus", "tools"],
  };
  const source = `export const manifest = ${JSON.stringify(manifest, null, 2)};\n\nconst AGENT = ${JSON.stringify(config, null, 2)};\n\n${runner}`;
  made.set(source, config);
  return source;
}

/** Whether an agent file is for agents outside the app (`outside: true`), so the plugin it makes runs on a space's server too. */
export function isOutsideFile(text: string): boolean {
  try {
    return split(text).meta.outside === true;
  } catch {
    return false;
  }
}

/** The fields an outside agent file may have: it brings no model, loop or wake-ups, since the agent is elsewhere. */
const OUTSIDE_KEYS = new Set(["id", "name", "description", "version", "permissions", "outside"]);

/** The door plugin an `outside: true` file makes: it opens the door to outside agents, with the file's text as their instructions. */
function fromOutsideFile(meta: Record<string, unknown>, body: string): string {
  if (meta.outside !== true) throw new AgentFileError("`outside` is true, for agents outside the app, or left out");
  for (const key of Object.keys(meta)) {
    if (!OUTSIDE_KEYS.has(key)) throw new AgentFileError(KEYS.has(key) ? `An outside agent file has no \`${key}\`: the agent brings its own model and loop` : `The frontmatter has no field \`${key}\``);
  }
  const text = (key: string) => {
    const v = meta[key];
    if (v !== undefined && typeof v !== "string") throw new AgentFileError(`\`${key}\` must be text`);
    return v as string | undefined;
  };
  const id = text("id");
  const name = text("name");
  if (!id) throw new AgentFileError("An outside agent file needs an `id`");
  if (!name) throw new AgentFileError("An outside agent file needs a `name`");
  const permissions = meta.permissions ?? [];
  if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== "string")) throw new AgentFileError("`permissions` must be a list");
  const instructions = body.trim();
  if (!instructions) throw new AgentFileError("Say what the app is for after the frontmatter: outside agents are told it when they connect");
  const manifest = {
    id,
    name,
    description: text("description") ?? `Lets agents outside the app use it: ${instructions.split("\n")[0].slice(0, 200)}`,
    version: text("version") ?? "1.0.0",
    // Opened in the browser for WebMCP, and on a space's server for MCP.
    runs: "both",
    permissions: [...new Set(["outside", ...(permissions as string[])])],
    services: ["outside", "tools"],
  };
  return `export const manifest = ${JSON.stringify(manifest, null, 2)};\n\nconst INSTRUCTIONS = ${JSON.stringify(instructions)};\n\nexport default async function (ctx) {\n  await ctx.call("outside", "open", { instructions: INSTRUCTIONS });\n}\n`;
}

/** The frontmatter, read, and the Markdown after it. */
function split(text: string): { meta: Record<string, unknown>; body: string } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new AgentFileError("An agent file starts with frontmatter between two --- lines");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new AgentFileError("The frontmatter has no closing --- line");
  const meta = readYaml(lines.slice(1, end));
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new AgentFileError("The frontmatter must be `key: value` lines");
  return { meta: meta as Record<string, unknown>, body: lines.slice(end + 1).join("\n") };
}

type Line = { indent: number; text: string; n: number };

/** The small part of YAML that frontmatter needs. */
export function readYaml(source: string[]): unknown {
  const lines: Line[] = [];
  source.forEach((raw, i) => {
    const text = stripComment(raw).trimEnd();
    if (!text.trim()) return;
    if (/^\s*\t/.test(raw)) throw new AgentFileError(`Line ${i + 2} of the frontmatter is indented with a tab; use spaces`);
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim(), n: i + 2 });
  });
  let i = 0;
  const fail = (line: Line, what: string): never => {
    throw new AgentFileError(`Line ${line.n} of the frontmatter: ${what}`);
  };

  function block(indent: number): unknown {
    const first = lines[i];
    return first.text === "-" || first.text.startsWith("- ") ? list(first.indent) : map(indent);
  }

  function map(indent: number, out: Record<string, unknown> = {}): Record<string, unknown> {
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith("- ")) {
      const line = lines[i++];
      const m = /^([\w-]+)\s*:(?:\s+(.*))?$/.exec(line.text);
      if (!m) fail(line, "expected `key: value`");
      const [, key, rest = ""] = m!;
      if (Object.hasOwn(out, key)) fail(line, `\`${key}\` appears twice`);
      if (rest) out[key] = scalar(rest, line);
      else if (i < lines.length && lines[i].indent > indent) out[key] = block(lines[i].indent);
      else if (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) out[key] = list(indent);
      else out[key] = null;
    }
    if (i < lines.length && lines[i].indent > indent) fail(lines[i], "unexpected indent");
    return out;
  }

  function list(indent: number): unknown[] {
    const out: unknown[] = [];
    while (i < lines.length && lines[i].indent === indent && (lines[i].text === "-" || lines[i].text.startsWith("- "))) {
      const line = lines[i++];
      const rest = line.text.slice(1).trim();
      if (!rest) {
        out.push(i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null);
        continue;
      }
      const pair = /^([\w-]+)\s*:(?:\s+(.*))?$/.exec(rest);
      if (pair && !/^["'[{]/.test(rest)) {
        // `- key: value`, perhaps with more of the same map on the lines below, two spaces in.
        const inner = indent + 2;
        lines.splice(i, 0, { indent: inner, text: rest, n: line.n });
        out.push(map(inner));
      } else out.push(scalar(rest, line));
    }
    return out;
  }

  if (!lines.length) return {};
  const value = block(lines[0].indent);
  if (i < lines.length) fail(lines[i], "unexpected indent");
  return value;
}

function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(text: string, line: Line): unknown {
  const t = text.trim();
  if (t.startsWith("[")) {
    if (!t.endsWith("]")) throw new AgentFileError(`Line ${line.n} of the frontmatter: a list with no closing ]`);
    return parts(t.slice(1, -1)).map((p) => scalar(p, line));
  }
  if (t.startsWith("{")) {
    if (!t.endsWith("}")) throw new AgentFileError(`Line ${line.n} of the frontmatter: a map with no closing }`);
    const out: Record<string, unknown> = {};
    for (const p of parts(t.slice(1, -1))) {
      const m = /^([\w-]+)\s*:\s*(.*)$/.exec(p);
      if (!m) throw new AgentFileError(`Line ${line.n} of the frontmatter: expected \`key: value\` in { }`);
      out[m[1]] = scalar(m[2], line);
    }
    return out;
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    if (t.length < 2) throw new AgentFileError(`Line ${line.n} of the frontmatter: an unclosed quote`);
    return t.startsWith('"') ? JSON.parse(t) : t.slice(1, -1).replaceAll("''", "'");
  }
  if (t === "true" || t === "false") return t === "true";
  if (t === "null" || t === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/** Splits `a, b, c` at the commas outside quotes. Lists and maps in { } and [ ] don't nest. */
function parts(text: string): string[] {
  const out: string[] = [];
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ",") {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((p) => p.trim()).filter(Boolean);
}
