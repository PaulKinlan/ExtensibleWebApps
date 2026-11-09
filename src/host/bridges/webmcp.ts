// webmcp: puts the tools a plugin opened to outside agents (std/outside/module.ts)
// on the page, as WebMCP tools, so an agent in the browser finds them there.
// The page registers each one with document.modelContext.registerTool (or
// navigator.modelContext, in browsers that put it there), and the tool's
// execute sends the call back to the kernel with the key this tab was given:
// the kernel runs it as the plugin, through the gate, and a write it reviews
// shows its card on this page as usual.
//
// A browser without WebMCP has nothing to register with: the offer says so,
// and nothing else changes.

import type { BridgeHost } from "./index";

/** A tool as the kernel offers it. */
interface Offered {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

interface Offer {
  plugin: string;
  name: string;
  key: string;
  instructions?: string;
  tools: Offered[];
}

/** The parts of WebMCP this uses, as the draft and the browsers that ship it have them. */
interface ModelContext {
  registerTool(tool: Record<string, unknown>, options?: { signal?: AbortSignal }): unknown;
  unregisterTool?(name: string): void;
}

/** Where the browser keeps WebMCP: on the document (the current draft), or on navigator (earlier ones). */
const contextHere = (): ModelContext | undefined => {
  const on = (document as unknown as { modelContext?: ModelContext }).modelContext ?? (navigator as unknown as { modelContext?: ModelContext }).modelContext;
  return on && typeof on.registerTool === "function" ? on : undefined;
};

export default (host: BridgeHost) => {
  /** Each plugin's tools on this page: how to take them off again. */
  const placed = new Map<string, { stop: AbortController; names: string[]; handles: unknown[] }>();

  function withdraw(plugin: string) {
    const was = placed.get(plugin);
    if (!was) return { ok: true };
    placed.delete(plugin);
    was.stop.abort();
    const context = contextHere();
    for (const handle of was.handles) (handle as { unregister?: () => void } | undefined)?.unregister?.();
    // An older browser takes tools off by name; one that takes a signal has already done it.
    for (const name of was.names) {
      try {
        context?.unregisterTool?.(name);
      } catch {}
    }
    return { ok: true };
  }

  async function offer(o: Offer) {
    withdraw(o.plugin);
    const context = contextHere();
    if (!context) return { ok: false, reason: "This browser has no WebMCP" };
    const stop = new AbortController();
    const names: string[] = [];
    const handles: unknown[] = [];
    const refused: string[] = [];
    for (const tool of o.tools) {
      const execute = async (input: unknown) => {
        // Earlier drafts passed the arguments as JSON text.
        const args = typeof input === "string" ? JSON.parse(input || "{}") : (input ?? {});
        const answer = (await host.command("outside:call", { key: o.key, name: tool.name, args })) as { ok: boolean; value?: unknown; error?: string } | undefined;
        if (!answer?.ok) throw new Error(answer?.error ?? "The app didn't answer");
        return typeof answer.value === "string" ? answer.value : JSON.stringify(answer.value ?? null);
      };
      try {
        handles.push(
          await context.registerTool(
            {
              name: tool.name,
              title: tool.name.replace(/_/g, " "),
              // WebMCP has no place for a server's instructions, so each tool carries what the app is for.
              description: `${o.name}: ${tool.description}${o.instructions ? `\n\nAbout this app: ${o.instructions}` : ""}`,
              inputSchema: tool.inputSchema,
              annotations: { readOnlyHint: tool.readOnly },
              execute,
            },
            { signal: stop.signal },
          ),
        );
        names.push(tool.name);
      } catch {
        // Another plugin on the page has a tool by that name already.
        refused.push(tool.name);
      }
    }
    placed.set(o.plugin, { stop, names, handles });
    return { ok: true, registered: names.length, ...(refused.length ? { refused } : {}) };
  }

  return { offer, withdraw, status: () => Object.fromEntries([...placed].map(([plugin, p]) => [plugin, p.names])) };
};
