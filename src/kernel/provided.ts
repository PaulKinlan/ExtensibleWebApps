// Services a sandboxed plugin provides (docs/layers.md). In Cordis a service
// is a plugin that provides a name; here a plugin in its own worker can too,
// so a std plugin, a person's own plugin or one their agent wrote can add a
// service as first-class as one the platform ships:
//
//   export const manifest = {
//     id: "mailer",
//     name: "Mailer",
//     permissions: ["provide:mail", "network:api.example.com"],
//     provides: { mail: { description: "Sends mail.", methods: {
//       send: { args: "({ to, subject, text })", returns: "{ id }", description: "Sends one message." },
//     } } },
//   };
//   export default (ctx) => ctx.provide("mail", { send: async ({ to, subject, text }) => ({ id: "…" }) });
//
// Other plugins call it like any service, `ctx.call("mail", "send", { … })`,
// with the permission `mail` (or what a method's `needs` says). The kernel
// passes each call to the provider through a bail hook named after it, so no
// other plugin can answer in its place, and the provider hears who called.
// Its methods go into the API reference, so `tools` offers them to models.
//
// A name the kernel, a kernel module or another plugin already has is
// refused, never shadowed.

import type { Dispatch, Manifest, ProvidedService } from "../shared/protocol";
import type { MethodDoc, ServiceProvider } from "./remote";

/** The hook a provider answers its service's calls on: named after the plugin, so only it can answer. */
export const serviceHook = (plugin: string, service: string) => `service:${plugin} ${service}`;

/** Longest a provider has to answer one call. */
export const SERVICE_TIMEOUT_MS = 60_000;
/** Longest a call waits for a provider that is installed but hasn't started listening yet. */
const WAIT_FOR_PROVIDER_MS = 5_000;
const MAX_ANSWER = 1_000_000;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Makes the kernel's side of a service a plugin provides. */
export function providedService(
  root: any,
  manifest: Manifest,
  name: string,
  spec: ProvidedService,
  listening: (hook: string) => boolean,
): ServiceProvider {
  const hook = serviceHook(manifest.id, name);
  const methods: Record<string, MethodDoc> = Object.fromEntries(
    Object.entries(spec.methods).map(([method, doc]) => [method, { args: doc.args ?? "()", returns: doc.returns ?? "", needs: doc.needs ?? name, description: doc.description, ...(doc.params ? { params: doc.params as MethodDoc["params"] } : {}) }]),
  );
  return {
    description: `${spec.description} Provided by the plugin “${manifest.name}” (${manifest.id}).`,
    methods,
    capability: (method) => methods[method]?.needs,
    async call(caller, method, args, dispatch: Dispatch) {
      const deadline = Date.now() + WAIT_FOR_PROVIDER_MS;
      while (!listening(hook) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      if (!listening(hook)) throw new Error(`${name} is provided by “${manifest.name}”, which isn't running`);
      // The runtime sends a handler's result as { value }, so a result that happens to hold `block` is still a result.
      const answer = await root.bail(dispatch, hook, { method, args, caller: caller.split("@")[0] });
      if (!isObject(answer) || !("value" in answer)) {
        const error = !isObject(answer) ? `${name}.${method} didn't answer` : String(answer.block).replace(/^.* could not answer .*? \((?:Error: )?(.*)\)$/s, "$1");
        throw new Error(error);
      }
      const json = JSON.stringify(answer.value ?? null);
      if (json.length > MAX_ANSWER) throw new Error(`${name}.${method} answered with more than 1 MB`);
      return JSON.parse(json);
    },
  };
}
