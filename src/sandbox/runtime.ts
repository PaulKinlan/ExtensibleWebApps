// The runtime inside each sandboxed plugin's worker. It loads the plugin's
// module from its source and gives it a `ctx` whose every call becomes a
// message to the kernel, where the capability gate checks it.
//
// Plugins written for the Markdown editor (they take an `editor` object and
// use editor-style permissions such as `post:read`) get a shim instead, so
// they run unchanged.

import type { KernelToPlugin, Manifest, PluginToKernel, Slot, View } from "../shared/protocol";

let port: MessagePort;
let nextListener = 0;
let nextCall = 0;
const handlers = new Map<number, (...args: any[]) => unknown>();
const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const eventHandlers = new Set<(action: string, value: unknown) => void>();
const canvasHandlers = new Map<string, (canvas: OffscreenCanvas) => void>();
const settingsHandlers = new Set<(values: Record<string, unknown>) => void>();

/** The trace id of the hook or event being handled; calls made while handling it carry it. */
let activeTrace: string | undefined;
const send = (message: PluginToKernel) => port.postMessage(message);

/** Runs a plugin handler with `trace` as the active trace for its synchronous part. */
function traced<T>(trace: string | undefined, fn: () => T): T {
  const previous = activeTrace;
  activeTrace = trace;
  try {
    return fn();
  } finally {
    activeTrace = previous;
  }
}
const log = (text: string, level: "info" | "error" = "info") => send({ t: "log", level, text });

/** The API a sandboxed plugin gets. */
const ctx = {
  on(name: string, handler: (...args: any[]) => unknown): () => void {
    const listener = ++nextListener;
    handlers.set(listener, handler);
    send({ t: "on", listener, name });
    return () => {
      handlers.delete(listener);
      send({ t: "off", listener });
    };
  },
  call(service: string, method: string, ...args: unknown[]): Promise<unknown> {
    const id = ++nextCall;
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject });
      send({ t: "call", id, service, method, args, trace: activeTrace });
    });
  },
  ui: {
    render(slot: Slot, key: string, view: View | null, order?: number) {
      send({ t: "render", slot, key, view, order, trace: activeTrace });
    },
    onEvent(handler: (action: string, value: unknown) => void) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    onCanvas(id: string, handler: (canvas: OffscreenCanvas) => void) {
      canvasHandlers.set(id, handler);
    },
  },
  /** The plugin's own settings, from the form the shell builds out of its manifest. */
  settings: {
    get: () => ctx.call("settings", "get") as Promise<Record<string, unknown>>,
    onChange(handler: (values: Record<string, unknown>) => void) {
      settingsHandlers.add(handler);
      return () => settingsHandlers.delete(handler);
    },
  },
  log,
};

/** The Markdown editor's `editor` API, on top of `ctx`, for the parts these demo notes support. */
function editorShim() {
  let post: any = null;
  const track = (p: any) => (post = p);
  ctx.on("note:open", track);
  ctx.on("note:change", track);
  ctx.on("note:save", track);
  ctx.on("note:close", () => (post = null));
  const events: Record<string, string> = { "post:open": "note:open", "post:change": "note:change", "post:save": "note:save", "post:close": "note:close" };
  const commands = new Map<string, () => unknown>();
  ctx.ui.onEvent((action) => commands.get(action)?.());
  return {
    on(event: string, handler: (value: unknown) => void) {
      const hook = events[event];
      if (!hook) {
        log(`The shim has no editor event ${event}`, "error");
        return () => {};
      }
      return ctx.on(hook, handler);
    },
    document: {
      get post() {
        return post;
      },
      get text() {
        return post?.text ?? "";
      },
      read: async () => post,
      annotate: async () => {},
    },
    ui: {
      status(id: string, text: string, title?: string) {
        const set = (t: string, ti?: string) => ctx.ui.render("statusbar", id, t ? { type: "text", text: t, title: ti } : null);
        set(text, title);
        return { set, remove: () => set("") };
      },
      notify: (message: string) => log(message),
    },
    registerCommand({ id, run }: { id: string; run: () => unknown }) {
      commands.set(`command:${id}`, run);
      return () => commands.delete(`command:${id}`);
    },
    storage: { get: async () => undefined, set: async () => {} },
    settings: { get: () => ctx.settings.get() },
  };
}

const isEditorExtension = (manifest: Manifest) => manifest.permissions.some((p) => p.startsWith("post:"));

async function load(source: string) {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const module = await import(/* @vite-ignore */ url);
    const manifest = module.manifest as Manifest;
    if (!manifest?.id || !Array.isArray(manifest.permissions)) throw new Error("The module has no manifest");
    send({ t: "ready", manifest });
    await module.default(isEditorExtension(manifest) ? editorShim() : ctx);
  } catch (error) {
    send({ t: "failed", error: String(error instanceof Error ? error.message : error) });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function receive(message: KernelToPlugin) {
  switch (message.t) {
    case "hook": {
      const handler = handlers.get(message.listener);
      if (message.id === undefined) {
        try {
          traced(message.trace, () => handler?.(...message.args));
        } catch (error) {
          log(String(error), "error");
        }
        return;
      }
      try {
        const value = await traced(message.trace, () => handler?.(...message.args));
        send({ t: "hook:result", id: message.id, ok: true, value });
      } catch (error) {
        send({ t: "hook:result", id: message.id, ok: false, error: String(error) });
      }
      return;
    }
    case "event":
      if (message.action === "settings:changed") {
        for (const handler of settingsHandlers) traced(message.trace, () => handler(message.value as Record<string, unknown>));
        return;
      }
      if (message.action === "kernel:denied") log(`Denied: ${message.value}`, "error");
      for (const handler of eventHandlers) traced(message.trace, () => handler(message.action, message.value));
      return;
    case "canvas":
      canvasHandlers.get(message.id)?.(message.canvas);
      return;
    case "result": {
      const waiting = calls.get(message.id);
      calls.delete(message.id);
      if (message.ok) waiting?.resolve(message.value);
      else waiting?.reject(new Error(message.error));
      return;
    }
  }
}

self.onmessage = (e: MessageEvent<{ t: "init"; source: string }>) => {
  if (e.data?.t !== "init") return;
  port = e.ports[0];
  port.onmessage = (m: MessageEvent<KernelToPlugin>) => void receive(m.data);
  port.start();
  void load(e.data.source);
};
