// The `hooks` service: a plugin runs the hooks it defines in its manifest's
// `hooks`. Each is named `<plugin>:<key>`, and only that plugin can run it,
// so no other can pretend a note was opened. Other plugins listen with
// ctx.on and the usual hook:listen or hook:intercept capability.
// Found by name: this file is src/kernel/services/hooks.ts, so it is `ctx.call("hooks", …)`.

import { hookOwners, hooks, PLUGIN_HOOKS } from "../hooks";
import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";

export default ({ root }: Kernel): ServiceProvider => {
  return {
    description: "The hooks a plugin defines in its manifest's `hooks`, named `<plugin>:<key>`. Only the plugin that defines a hook runs it; others listen with ctx.on, as for the kernel's own hooks.",
    methods: {
      emit: { args: "(key, value)", returns: "nothing", description: "Tells every listener of one of the plugin's own emit or parallel hooks, with value. ctx.hooks.emit(key, value) is the same." },
      call: {
        args: "(key, value)",
        returns: "what the listeners answer: the first answer of a serial or bail hook ({ block } stops the action), or value as the listeners left it after a waterfall",
        description: "Runs one of the plugin's own serial, bail or waterfall hooks and waits for its listeners, each within the hook's time limit. ctx.hooks.call(key, value) is the same.",
      },
    },
    // Ownership is checked in `call`: a plugin needs nothing to run its own hooks.
    capability: () => undefined,
    call: async (instance, method, args, dispatch) => {
      const id = instance.split("@")[0];
      const key = String(args[0]);
      const name = `${id}:${key}`;
      const spec = hookOwners.get(name) === id ? hooks.get(name) : undefined;
      if (!spec) throw new Error(`${id} has no hook ${key}: define it in the manifest's hooks`);
      const value = args[1] === undefined ? null : args[1];
      if (JSON.stringify(value).length > PLUGIN_HOOKS.maxValue) throw new Error(`A hook's value is limited to ${PLUGIN_HOOKS.maxValue} characters of JSON`);
      const tells = spec.mode === "emit" || spec.mode === "parallel";
      if (method === "emit") {
        if (!tells) throw new Error(`${name} is a ${spec.mode} hook, which waits for answers: run it with hooks.call`);
        if (spec.mode === "parallel") await root.parallel(dispatch, name, value);
        else root.emit(dispatch, name, value);
        return null;
      }
      if (method !== "call") throw new Error(`hooks.${method} is not a method`);
      if (tells) throw new Error(`${name} is an ${spec.mode} hook, which only tells: run it with hooks.emit`);
      if (spec.mode === "waterfall") {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A waterfall hook's value is an object its listeners can change");
        return (await root.waterfall(dispatch, name, value, () => value)) ?? null;
      }
      return (await root[spec.mode](dispatch, name, value)) ?? null;
    },
  };
};
