// The `commands` service: things a person (or an agent) can do in an app,
// named once by the plugin that does them, and run from anywhere: a command
// palette, a keyboard shortcut, or a model's tool call.
// A kernel module (docs/layers.md): a site that lists `commands` in kernel.json has it, as `ctx.call("commands", …)`.
//
// A plugin adds a command with a handler:
//
//   ctx.commands.add({ id: "finish", title: "Mark what I'm reading as done", keys: ["Alt+D"] }, async () => { … });
//
// That is two messages (src/sandbox/runtime.ts): `commands.add` here, which
// keeps the title, keys and arguments, and a listener on `command:finish`,
// which the kernel names after the plugin's own instance (remote.ts), so no
// other plugin can answer for it.
//
// Plugins with the `commands` permission list the app's commands and run
// them. std/commands/palette.js is one: it draws the palette and catches the
// keys. The tools service offers `commands_list` and `commands_run` to a model
// whose plugin holds the permission, so an agent can do whatever the app's
// commands do, without a tool written for it.
//
// A command runs with its own plugin's rights, never the caller's: running
// "Clear the shelf" lets the library clear its own shelf, as its button would.
// That is why `commands:before` exists. Any plugin may intercept it (with
// hook:intercept:commands:before) and stop a run, such as an agent's, before
// it happens; `commands:ran` tells the rest it did.

import { commandHook, type ServiceProvider } from "../../src/kernel/remote";
import { checkSchema, validate, type Schema } from "../../src/kernel/schema";
import { service, type ModuleKernel } from "../../src/kernel/modules";

/** A command as its plugin adds it. */
interface Command {
  id: string;
  title: string;
  description?: string;
  /** Shortcuts, such as "Mod+K" (Cmd on a Mac, Ctrl elsewhere), "Shift+N" or "?". */
  keys?: string[];
  /** A heading the palette puts it under. */
  group?: string;
  /** The arguments it takes, as an object schema. A palette shows only commands that need none. */
  args?: Schema;
}

/** A command as callers see it: `name` is `<plugin>/<id>`, which is what `run` takes. */
interface Listed extends Command {
  name: string;
  plugin: string;
}

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const MODIFIER = new Set(["Mod", "Ctrl", "Alt", "Shift", "Meta"]);
/** A key: one character, or a name from KeyboardEvent.key. */
const KEY = /^(?:[^\s+]|\+|Enter|Escape|Space|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-2]))$/;
const MAX_COMMANDS = 100;
const MAX_ANSWER = 1_000_000;

const base = (instance: string) => instance.split("@")[0];
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`A command's ${field} must be text of at most ${max} characters`);
  return value.trim();
}

/** Checks a command as a plugin gave it, and returns a plain copy. */
function checkCommand(input: unknown): Command {
  if (!isObject(input)) throw new Error("commands.add takes { id, title, description?, keys?, group?, args? }");
  const id = input.id;
  if (typeof id !== "string" || !ID.test(id)) throw new Error("A command's id is lowercase letters, digits and dashes, starting with a letter");
  const command: Command = { id, title: text(input.title, "title", 120, true)! };
  const description = text(input.description, "description", 500);
  const group = text(input.group, "group", 60);
  if (description) command.description = description;
  if (group) command.group = group;
  if (input.keys !== undefined) {
    if (!Array.isArray(input.keys) || input.keys.length > 3) throw new Error("A command's keys are a list of at most 3 shortcuts");
    command.keys = input.keys.map((combo) => {
      const parts = typeof combo === "string" ? combo.split(/\+(?!$)/) : [];
      const key = parts.pop() ?? "";
      if (!KEY.test(key) || parts.some((m) => !MODIFIER.has(m)) || new Set(parts).size !== parts.length) throw new Error(`${JSON.stringify(combo)} isn't a shortcut: write it as modifiers and a key, such as "Mod+K" or "Shift+N"`);
      return combo as string;
    });
  }
  if (input.args !== undefined) {
    checkSchema(input.args, "args");
    if (input.args.type !== "object") throw new Error("A command's args is an object schema: { type: \"object\", properties: { … } }");
    command.args = JSON.parse(JSON.stringify(input.args));
  }
  return command;
}

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { root, remote, apps } = kernel;
  kernel.hook("commands:changed", {
    mode: "emit",
    needs: "commands",
    args: "{}",
    description: "A command was added or removed, or the plugin that added it stopped. Call commands.list() again.",
  });
  kernel.hook("commands:before", {
    mode: "serial",
    timeoutMs: 15_000,
    onFailure: "open",
    args: "{ name, plugin, id, args, by, as? }",
    description: "Before a command runs; `by` is the plugin that ran it (the palette, an agent), and as is \"person\" when that is an agent acting for the person. Return { block: reason } to stop it.",
  });
  kernel.hook("commands:ran", {
    mode: "emit",
    needs: "commands",
    args: "{ name, plugin, id, by, as?, ok, error? }",
    description: "A command ran, or failed (ok false, with the error). Its arguments aren't included: listen to commands:before for those.",
  });
  /** Each plugin instance's commands, by id. */
  const added = new Map<string, Map<string, Command>>();
  // A plugin adds its commands one call each as it starts: say so once for the lot.
  let pending: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(pending);
    pending = setTimeout(() => root.emit({}, "commands:changed", {}), 50);
  };

  // An instance that stops takes its commands with it (kernel.ts says so as internal/stopped).
  root.on("internal/stopped", (instance: string) => {
    if (added.delete(instance)) changed();
  });
  // When the module stops, no commands:changed comes late.
  kernel.cleanup(() => clearTimeout(pending));

  /**
   * The commands the caller can run, each with the instance that answers it:
   * those of plugins in the caller's app (for a plugin no app links, those of
   * other such plugins), from the caller's own tab where a plugin runs one
   * instance per tab. Only commands whose plugin listens for them are listed.
   */
  function visible(caller: string): { command: Listed; instance: string }[] {
    const tab = caller.split("@")[1];
    // A tab's own instance sees only its tab's app; alongside() would add every other app that links the same plugin.
    const linked = tab ? apps.linkedBy(tab) : undefined;
    const app = linked ? new Set(linked) : apps.alongside(caller);
    const out = new Map<string, { command: Listed; instance: string }>();
    for (const [instance, commands] of added) {
      const live = remote.live.get(instance);
      if (!live) {
        added.delete(instance);
        continue;
      }
      const plugin = base(instance);
      const ownTab = instance.split("@")[1];
      if (app ? !app.has(plugin) : apps.alongside(instance) !== undefined) continue;
      if (tab && ownTab && ownTab !== tab) continue;
      const heard = new Set(live.heard);
      for (const command of commands.values()) {
        const name = `${plugin}/${command.id}`;
        if (!out.has(name) && heard.has(commandHook(instance, command.id))) out.set(name, { command: { name, plugin, ...command }, instance });
      }
    }
    return [...out.values()].sort((a, b) => (a.command.group ?? "").localeCompare(b.command.group ?? "", "en") || a.command.title.localeCompare(b.command.title, "en"));
  }

  return {
    description: "Commands: things to do in an app, added by the plugin that does them, and run from a palette, a shortcut or an agent's tool call.",
    methods: {
      add: {
        args: "({ id, title, description?, keys?, group?, args? })",
        returns: "true",
        description: "Adds (or replaces) one of the caller's commands. Use `ctx.commands.add(command, handler)`, which also listens for it. `keys` are up to 3 shortcuts such as \"Mod+K\" (Cmd on a Mac, Ctrl elsewhere); `args` is an object schema for what the handler takes.",
      },
      remove: {
        args: "(id)",
        returns: "true",
        description: "Removes one of the caller's commands. The `off()` that `ctx.commands.add` returns does this.",
      },
      list: {
        args: "()",
        returns: "[{ name, plugin, id, title, description?, keys?, group?, args? }]",
        needs: "commands",
        params: [],
        description: "The commands of the caller's app, sorted by group and title. Run one with `commands.run(name)`; `name` is `<plugin>/<id>`.",
      },
      run: {
        args: "(name, args?)",
        returns: "what the command's handler returns",
        needs: "commands",
        params: [
          { name: "name", schema: { type: "string", description: "The command's name from commands_list, such as library/finish" } },
          { name: "args", optional: true, schema: { type: "object", description: "The command's arguments, if its listing has an args schema" } },
        ],
        description: "Runs a command of the caller's app, with its own plugin's rights. `commands:before` can stop it first. Fails if the handler throws or takes longer than two minutes.",
      },
    },
    capability: (method) => (method === "list" || method === "run" ? "commands" : undefined),
    call: async (instance, method, args, dispatch) => {
      if (method === "add") {
        const command = checkCommand(args[0]);
        const mine = added.get(instance) ?? new Map<string, Command>();
        if (!mine.has(command.id) && mine.size >= MAX_COMMANDS) throw new Error(`A plugin can add at most ${MAX_COMMANDS} commands`);
        mine.set(command.id, command);
        added.set(instance, mine);
        changed();
        return true;
      }
      if (method === "remove") {
        if (added.get(instance)?.delete(String(args[0]))) changed();
        return true;
      }
      if (method === "list") return visible(instance).map((v) => v.command);
      if (method !== "run") throw new Error(`commands.${method} is not a method`);

      const [name, given] = args;
      const found = visible(instance).find((v) => v.command.name === name);
      if (!found) throw new Error(`No command named ${String(name)} in this app`);
      const { command } = found;
      const input = given ?? {};
      if (!isObject(input)) throw new Error(`${command.name} takes its arguments as an object`);
      if (command.args) {
        const errors = validate(command.args, input, "args");
        if (errors.length) throw new Error(`${command.name}: ${errors.map((e) => e.message).join("; ")}`);
      } else if (Object.keys(input).length) throw new Error(`${command.name} takes no arguments`);

      // A run with no trace of its own (a call made outside any action) gets one, so its hooks group together in the trace, as a route's do.
      dispatch = dispatch.trace ? dispatch : { ...dispatch, trace: `command-${Math.random().toString(36).slice(2, 8)}` };
      // An agent acting for the person (acts-as: person) runs it for them: say so.
      const as = dispatch.via && dispatch.via === base(instance) ? { as: "person" } : {};
      const about = { name: command.name, plugin: command.plugin, id: command.id, args: input, by: base(instance), ...as };
      const verdict = await root.serial(dispatch, "commands:before", about);
      if (isObject(verdict) && "block" in verdict) throw new Error(`${command.name} was stopped: ${String(verdict.block)}`);
      // The runtime sends a handler's result as { value }, so a result that happens to hold `block` or `failed` is still a result.
      const answer = await root.bail(dispatch, commandHook(found.instance, command.id), input, { by: about.by });
      // What went out to every plugin with `commands`: which command and who ran it, not the arguments, which may be private to the app.
      const told = { name: command.name, plugin: command.plugin, id: command.id, by: about.by, ...as };
      if (!isObject(answer) || !("value" in answer)) {
        // The kernel's words for a handler that threw or took too long: keep only what went wrong.
        const said = !isObject(answer) ? `${command.name} didn't answer` : String(answer.block).replace(/^.* could not answer .*? \((?:Error: )?(.*)\)$/s, "$1");
        // Its plugin stopped while it ran (src/kernel/remote.ts, dispose): say which command that was.
        const error = said === "plugin stopped" ? `${command.name} wasn't answered: its plugin stopped` : said;
        root.emit(dispatch, "commands:ran", { ...told, ok: false, error });
        throw new Error(error);
      }
      root.emit(dispatch, "commands:ran", { ...told, ok: true });
      const json = JSON.stringify(answer.value ?? null);
      if (json.length > MAX_ANSWER) throw new Error(`${command.name} answered with more than 1 MB`);
      return JSON.parse(json);
    },
  };
};

export default service("commands", make);
