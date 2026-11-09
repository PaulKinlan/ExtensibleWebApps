// The `outside` service: lets agents that live outside the app (a browser's
// own assistant, Claude Code, any MCP client) use it. An app opts in by
// linking a plugin that opens the door:
//
//   export const manifest = {
//     id: "reading-list-agents", name: "Outside agents", runs: "both",
//     permissions: ["outside", "data:read:books", "data:write:books"], services: ["outside"],
//   };
//   export default (ctx) => ctx.call("outside", "open", { instructions: "You help with a reading list." });
//
// An outside agent then acts as that plugin, with exactly its permissions:
// its tools are the plugin's tools (std/tools/module.ts), each call goes
// through the same gate as the plugin's own ctx.call, and a write to data the
// plugin doesn't own is reviewed by the person on the same card. So an app's
// author decides what outside agents may reach by what the plugin's manifest
// asks for, and the person sees it as they see any plugin's.
//
// Two doors, one set of tools:
//
// - In a tab, the tools are WebMCP tools: the host registers them with
//   document.modelContext (or navigator.modelContext in older browsers), so an
//   agent in the browser finds them on the page (src/host/bridges/webmcp.ts).
//   A tool's call comes back to the kernel as the page command `outside:call`,
//   with the key this tab was given, and runs as the plugin.
// - On a space's server, the tools are an MCP server at /s/<space>/mcp/<plugin>,
//   which the server's host lets only a member's agent key reach. The host
//   hands the kernel the request at the door `mcp` (ModuleKernel.door), and
//   this answers it: MCP's JSON-RPC over plain HTTP, with no
//   streaming, which is all its tools need.
//
// On the server, a review is sent to the members' devices that have the space
// open (std/spaces/reviews.ts), since the server has no screen. An MCP
// call waits for the answer for up to REVIEW_WAIT_MS, then says it is still
// waiting.
//
// A kernel module (docs/layers.md): a site that lists `outside` (and `tools`) in kernel.json has it.

import { callService, type ServiceProvider } from "../../src/kernel/remote";
import type { ModuleKernel } from "../../src/kernel/modules";
import type { Host } from "../../src/kernel/hosts";
import type { Tool } from "../tools/module";
import { record } from "../../src/kernel/trace";

/** The MCP version this server speaks; a client asking for another is answered with this one. */
export const MCP_VERSION = "2025-06-18";
/** How long an MCP tool call waits for a review before saying it is still waiting. */
export const REVIEW_WAIT_MS = 100_000;
/** Tool calls one door takes in an hour, from all its agents. */
export const CALLS_PER_HOUR = 600;

const base = (instance: string) => instance.split("@")[0];
const MAX_INSTRUCTIONS = 4000;

/** A door a plugin opened. */
interface Door {
  instance: string;
  name: string;
  instructions?: string;
  /** Per tab: the key the tab's tools carry back, so a call names the door it came through. */
  keys: Map<string, string>;
  /** When each of this hour's calls was made. */
  calls: number[];
}

/** A JSON-RPC message from an MCP client. */
interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const random = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** A tool's answer as text, for a model to read. */
const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? null));

/** Whether a tool only reads: what WebMCP and MCP call readOnlyHint. */
const readOnly = (tool: Tool) => /^(get|list|collections|hooks|read|search|current|reference)/.test(tool.method);

export default {
  name: "outside",
  uses: ["tools"],
  apply(_ctx: any, kernel: ModuleKernel) {
    const { root, hosts, remote, apps } = kernel;
    /** The doors open now, by plugin instance. */
    const doors = new Map<string, Door>();

    kernel.hook("outside:called", {
      mode: "emit",
      needs: "outside",
      args: "{ plugin, tool, via: \"webmcp\" | \"mcp\", member?, ok }",
      description: "An outside agent called one of a plugin's tools, through WebMCP in a tab or MCP on a space's server. It carries the tool's name, not its arguments or answer.",
    });

    /** The tabs where a door's plugin is part of the open app. */
    const tabsOf = (door: Door): Host[] => {
      const [id, tab] = door.instance.split("@");
      if (tab) return hosts.list.filter((h) => h.tab === tab);
      return hosts.list.filter((h) => apps.linkedBy(h.tab)?.includes(id));
    };

    const toolsOf = async (door: Door, dispatch: { trace?: string }) => (await remote.services.tools.call(door.instance, "list", [], dispatch)) as Tool[];

    /** Puts a door's tools on a tab's page, or takes them off (tools = null). */
    async function offer(door: Door, host: Host, dispatch: { trace?: string }) {
      if (hosts.mode === "server") return;
      let key = door.keys.get(host.tab);
      if (!key) door.keys.set(host.tab, (key = random()));
      const tools = (await toolsOf(door, dispatch)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters, readOnly: readOnly(t) }));
      await hosts.bridge("webmcp", "offer", [{ plugin: base(door.instance), name: door.name, key, instructions: door.instructions, tools }], dispatch, host).catch((error: unknown) => {
        record({ kind: "error", name: "outside:offer-failed", plugin: door.instance, detail: String(error instanceof Error ? error.message : error) });
      });
    }

    async function withdraw(door: Door) {
      if (hosts.mode === "server") return;
      for (const host of tabsOf(door)) await hosts.bridge("webmcp", "withdraw", [base(door.instance)], {}, host).catch(() => {});
      door.keys.clear();
    }

    /** Calls a tool as the door's plugin: the same gate and reviews as its own ctx.call. */
    async function call(door: Door, name: string, args: unknown, via: "webmcp" | "mcp", dispatch: { trace?: string }, member?: string): Promise<unknown> {
      const now = Date.now();
      door.calls = door.calls.filter((at) => now - at < 3_600_000);
      if (door.calls.length >= CALLS_PER_HOUR) throw new Error(`Outside agents may call ${door.name}'s tools ${CALLS_PER_HOUR} times an hour; try again later`);
      door.calls.push(now);
      const caps = remote.installed.get(base(door.instance))?.caps ?? new Set<string>();
      let ok = false;
      try {
        const value = await callService(remote.services, door.instance, caps, "tools", "call", [name, args ?? {}], dispatch);
        ok = true;
        return value;
      } finally {
        root.emit(dispatch, "outside:called", { plugin: base(door.instance), tool: name, via, ...(member ? { member } : {}), ok });
      }
    }

    root.on("internal/stopped", (instance: string) => {
      const door = doors.get(instance);
      if (!door) return;
      doors.delete(instance);
      void withdraw(door);
    });
    // A tab that opens the app later gets the tools too, and plugins starting or stopping change what the
    // tools are (a collection comes or goes): offer each door's tools again, to the tabs that have its app
    // open now. A tab that has closed takes its key with it.
    let refreshing: ReturnType<typeof setTimeout> | undefined;
    root.on("plugins:changed", () => {
      clearTimeout(refreshing);
      refreshing = setTimeout(() => {
        for (const door of doors.values()) {
          const open = tabsOf(door);
          for (const tab of [...door.keys.keys()]) if (!open.some((h) => h.tab === tab)) door.keys.delete(tab);
          for (const host of open) void offer(door, host, { trace: "outside:refresh" });
        }
      }, 300);
    });
    kernel.cleanup(() => {
      clearTimeout(refreshing);
      for (const door of doors.values()) void withdraw(door);
      doors.clear();
    });

    // A WebMCP tool's call, from the page that has it: its key says which door, and which tab.
    kernel.command("outside:call", async (arg) => {
      const { key, name, args } = (arg ?? {}) as { key?: unknown; name?: unknown; args?: unknown };
      const door = [...doors.values()].find((d) => [...d.keys.values()].includes(String(key)));
      if (!door || typeof name !== "string") return { ok: false, error: "That tool isn't offered here any more" };
      const trace = `webmcp-${random().slice(0, 8)}`;
      try {
        return { ok: true, value: await call(door, name, args, "webmcp", { trace }) };
      } catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error) };
      }
    });

    /** An MCP request (JSON-RPC, one message or a batch) to the door of the plugin `plugin`, from a member's agent. */
    async function mcp(plugin: string, member: string | undefined, body: unknown): Promise<{ status: number; json?: unknown }> {
      const door = [...doors.values()].find((d) => base(d.instance) === plugin);
      const one = async (rpc: Rpc): Promise<unknown> => {
        const reply = (result: unknown) => ({ jsonrpc: "2.0", id: rpc.id ?? null, result });
        const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message } });
        if (!rpc || typeof rpc !== "object" || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return fail(-32600, "Not a JSON-RPC 2.0 request");
        // A notification (no id) is heard, not answered.
        if (rpc.id === undefined) return undefined;
        if (!door) return fail(-32001, `No plugin called ${plugin} has opened a door to outside agents in this space. Open its app in the space once, so the space starts it.`);
        const dispatch = { trace: `mcp-${random().slice(0, 8)}` };
        switch (rpc.method) {
          case "initialize":
            return reply({
              protocolVersion: MCP_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: door.name, version: "1.0.0" },
              ...(door.instructions ? { instructions: door.instructions } : {}),
            });
          case "ping":
            return reply({});
          case "tools/list":
            return reply({
              tools: (await toolsOf(door, dispatch)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters, annotations: { readOnlyHint: readOnly(t) } })),
            });
          case "tools/call": {
            const name = rpc.params?.name;
            if (typeof name !== "string") return fail(-32602, "tools/call needs the tool's name");
            let timer: ReturnType<typeof setTimeout> | undefined;
            const waiting = new Promise<never>((_, late) => (timer = setTimeout(() => late(new Error("The person hasn't answered the review yet. It is still waiting on their screen; call again later to see whether it happened.")), REVIEW_WAIT_MS)));
            try {
              const value = await Promise.race([call(door, name, rpc.params?.arguments, "mcp", dispatch, member), waiting]);
              return reply({ content: [{ type: "text", text: asText(value) }], isError: false });
            } catch (error) {
              // A tool's own failure is its result, for the model to read; only a malformed request is a JSON-RPC error.
              return reply({ content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }], isError: true });
            } finally {
              clearTimeout(timer);
            }
          }
          default:
            return fail(-32601, `This server has no method ${rpc.method}`);
        }
      };
      if (Array.isArray(body)) {
        const answers = (await Promise.all(body.slice(0, 20).map((m) => one(m as Rpc)))).filter((a) => a !== undefined);
        return answers.length ? { status: 200, json: answers } : { status: 202 };
      }
      const answer = await one(body as Rpc);
      return answer === undefined ? { status: 202 } : { status: 200, json: answer };
    }

    // The server's host hands the kernel an MCP request it has let in (src/server/mcp.ts): /mcp/<plugin>.
    kernel.door("mcp", async (request) => {
      if (hosts.mode !== "server") return null;
      const { status, json } = await mcp(request.path.split("/")[2] ?? "", request.member, request.form);
      return json === undefined ? { status } : { status, json };
    });

    const provider: ServiceProvider = {
      description: "Lets agents outside the app use it: a plugin that opens the door gives them its own tools, as WebMCP tools in the page and as an MCP server on a space's server, with its own permissions and reviews.",
      methods: {
        open: {
          args: "({ instructions? })",
          returns: "{ ok, tools: number }",
          needs: "outside",
          description: "Opens the door for outside agents: they may call this plugin's tools (tools.list), as this plugin. In a tab, its tools appear to the browser's agents through WebMCP; on a space's server, at /s/<space>/mcp/<plugin> for members' agents. `instructions` tells them what the app is for.",
        },
        close: {
          args: "()",
          returns: "{ ok }",
          needs: "outside",
          description: "Closes the door: outside agents can no longer call this plugin's tools.",
        },
        status: {
          args: "()",
          returns: "{ open, tools: [name], via: [\"webmcp\" | \"mcp\"] }",
          needs: "outside",
          description: "Whether this plugin's door is open, which tools it offers, and how outside agents reach it here.",
        },
      },
      capability: () => "outside",
      call: async (instance, method, args, dispatch) => {
        if (method === "open") {
          const given = (args[0] ?? {}) as { instructions?: unknown };
          const instructions = typeof given.instructions === "string" ? given.instructions.slice(0, MAX_INSTRUCTIONS) : undefined;
          const plugin = remote.installed.get(base(instance));
          const door: Door = doors.get(instance) ?? { instance, name: plugin?.manifest.name ?? base(instance), keys: new Map(), calls: [] };
          door.instructions = instructions;
          doors.set(instance, door);
          for (const host of tabsOf(door)) await offer(door, host, dispatch);
          record({ kind: "note", name: "outside:open", plugin: instance, trace: dispatch.trace, detail: hosts.mode === "server" ? "mcp" : "webmcp" });
          return { ok: true, tools: (await toolsOf(door, dispatch)).length };
        }
        if (method === "close") {
          const door = doors.get(instance);
          if (door) {
            doors.delete(instance);
            await withdraw(door);
          }
          return { ok: true };
        }
        if (method === "status") {
          const door = doors.get(instance);
          return { open: !!door, tools: door ? (await toolsOf(door, dispatch)).map((t) => t.name) : [], via: hosts.mode === "server" ? ["mcp"] : ["webmcp"] };
        }
        throw new Error(`outside.${method} is not a method`);
      },
    };
    kernel.provide("outside", provider);
  },
};
