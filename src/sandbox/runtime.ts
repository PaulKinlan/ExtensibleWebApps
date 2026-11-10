// The runtime inside each sandboxed plugin's worker. It loads the plugin's
// module from its source and gives it a `ctx` whose every call becomes a
// message to the kernel, where the capability gate checks it.

import type { Api, Live, RouteRequest } from "../shared/api";
import { lockdown } from "./lockdown";
import type { CanvasTheme, KernelToPlugin, Manifest, PluginToKernel, Slot, View } from "../shared/protocol";

let port: MessagePort;
let nextListener = 0;
let nextCall = 0;
const handlers = new Map<number, (...args: any[]) => unknown>();
const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const eventHandlers = new Set<(action: string, value: unknown) => void>();
const canvasHandlers = new Map<string, (canvas: OffscreenCanvas, theme?: CanvasTheme) => void>();
const themeHandlers = new Set<(theme: CanvasTheme) => void>();
/** Each job's listener, by name, so setting a name again replaces the old handler (ctx.schedule). */
const jobListeners = new Map<string, () => void>();
/** Each command's listener, by id, so adding an id again replaces the old handler (ctx.commands.add). */
const commandListeners = new Map<string, () => void>();
const settingsHandlers = new Set<(values: Record<string, unknown>) => void>();

/** The trace id of the hook or event being handled; calls made while handling it carry it. */
let activeTrace: string | undefined;
const send = (message: PluginToKernel) => port.postMessage(message);
/** The name of an error for a call whose service had no running provider to answer it (the kernel says so with `gone`). */
const GONE = "ServiceGone";

/**
 * Runs a plugin handler with `trace` as the active trace for its synchronous
 * part, and with `this` set to an API bound to that trace for the rest.
 */
function traced<T>(trace: string | undefined, fn: (api: Api) => T): T {
  const previous = activeTrace;
  activeTrace = trace;
  try {
    return fn(trace === undefined ? ctx : api(() => trace));
  } finally {
    activeTrace = previous;
  }
}

function api(trace: () => string | undefined): Api {
  const log = (text: string, level: "info" | "error" = "info") => send({ t: "log", level, text, trace: trace() });
  const call = (service: string, method: string, ...args: unknown[]): Promise<unknown> => {
    const id = ++nextCall;
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject });
      send({ t: "call", id, service, method, args, trace: trace() });
    });
  };
  /**
   * Listens for a job's hook, then sets the job. Setting a name again replaces its handler. The `off()` stops
   * listening; the job is kept until cancelled.
   */
  const scheduled = (name: string, handler: () => unknown, set: () => Promise<unknown>) => {
    jobListeners.get(name)?.();
    const off = self.on(`schedule:${name}`, async () => {
      await handler();
    });
    jobListeners.set(name, off);
    set().catch((error) => log(`Couldn't schedule ${name}: ${error instanceof Error ? error.message : error}`, "error"));
    return () => {
      // A replaced handler's off() leaves its replacement alone.
      if (jobListeners.get(name) !== off) return;
      jobListeners.delete(name);
      off();
    };
  };
  const self: Api = {
    on(name: string, handler: (...args: any[]) => unknown): () => void {
      const listener = ++nextListener;
      handlers.set(listener, handler);
      send({ t: "on", listener, name });
      return () => {
        handlers.delete(listener);
        send({ t: "off", listener });
      };
    },
    call,
    hooks: {
      emit: (key: string, value?: unknown) => call("hooks", "emit", key, value).then(() => {}),
      call: (key: string, value?: unknown) => call("hooks", "call", key, value),
    },
    routes: {
      add(method, path, handler) {
        return self.on(`route:${String(method).toUpperCase()} ${path}`, (request: RouteRequest) => handler(request));
      },
    },
    schedule: {
      every(name, ms, handler) {
        return scheduled(name, handler, () => call("schedule", "every", name, ms));
      },
      at(name, when, handler) {
        return scheduled(name, handler, () => call("schedule", "at", name, when));
      },
      cancel: (name) => call("schedule", "cancel", name).then(() => {}),
    },
    commands: {
      add(command, handler) {
        const id = String(command?.id);
        // Adding an id again replaces it: the old handler stops listening.
        commandListeners.get(id)?.();
        // Listen first: the kernel lists a command only once its plugin is listening for it. The result goes back
        // as { value }, so the kernel can tell it from its own failure answers.
        const off = self.on(`command:${id}`, async (args: Record<string, unknown>, about: { by: string }) => ({ value: await handler(args, about) }));
        commandListeners.set(id, off);
        call("commands", "add", command).catch((error) => log(`Couldn't add the command ${id}: ${error instanceof Error ? error.message : error}`, "error"));
        return () => {
          // A replaced registration's off() leaves its replacement alone.
          if (commandListeners.get(id) !== off) return;
          commandListeners.delete(id);
          off();
          void call("commands", "remove", id).catch(() => {});
        };
      },
    },
    provide(name, methods) {
      // The result goes back as { value }, so the kernel can tell it from its own failure answers.
      return self.on(`service:${name}`, async ({ method, args, caller }: { method: string; args: unknown[]; caller: string }) => {
        const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
        if (typeof handler !== "function") throw new Error(`${name}.${method} has no handler`);
        return { value: await handler(...(Array.isArray(args) ? args : []), { caller }) };
      });
    },
    ui: {
      render(slot: Slot, key: string, view: View | string | null, order?: number) {
        send({ t: "render", slot, key, view: typeof view === "string" ? { type: "html", html: view } : view, order, trace: trace() });
      },
      html,
      live(slot: Slot, key: string, compute: (ctx: Api) => unknown, order?: number) {
        return live(self, compute, (view) => self.ui.render(slot, key, view as View | string | null, order));
      },
      views(file: string) {
        const views = {
          render(slot: Slot, id: string, data?: unknown, options: { key?: string; order?: number } = {}) {
            send({ t: "render", slot, key: options.key ?? id, view: { type: "template", src: file, id, data }, order: options.order, trace: trace() });
          },
          live(slot: Slot, id: string, compute: (ctx: Api) => unknown, options: { key?: string; order?: number } = {}) {
            return live(self, compute, (data) => views.render(slot, id, data, options));
          },
        };
        return views;
      },
      onEvent(handler: (action: string, value: unknown) => void) {
        eventHandlers.add(handler);
        return () => void eventHandlers.delete(handler);
      },
      onCanvas(id: string, handler: (canvas: OffscreenCanvas, theme?: CanvasTheme) => void) {
        canvasHandlers.set(id, handler);
      },
      onTheme(handler: (theme: CanvasTheme) => void) {
        themeHandlers.add(handler);
        return () => void themeHandlers.delete(handler);
      },
    },
    settings: {
      get: () => call("settings", "get") as Promise<Record<string, unknown>>,
      onChange(handler: (values: Record<string, unknown>) => void) {
        settingsHandlers.add(handler);
        return () => void settingsHandlers.delete(handler);
      },
    },
    storage: {
      get: (key: string) => call("storage", "get", key),
      set: (key: string, value: unknown) => call("storage", "set", key, value),
    },
    /** A copy of this API whose calls carry the trace active now, even after an `await`. */
    traced(): Api {
      const pinned = trace();
      return api(() => pinned);
    },
    log,
  };
  return self;
}

/**
 * A live view. `compute` gets a copy of ctx that notes what it reads: each
 * collection it lists or gets, and the settings. Once it has drawn, a change
 * to any of them computes and draws again. Changes that arrive while it is
 * computing are folded into one more run, so a burst of writes draws twice
 * at most. A read that fails (a collection no app has made yet) is still
 * followed, so the view fills in when it appears.
 */
function live(base: Api, compute: (ctx: Api) => unknown, draw: (value: unknown) => void): Live {
  const followed = new Map<string, () => void>();
  let stopped = false;
  let running = false;
  let again = false;

  // Keys are "data:<collection>" and "settings", so a collection named settings is its own dependency.
  const follow = (what: string) => {
    if (stopped || followed.has(what)) return;
    followed.set(what, what === "settings" ? base.settings.onChange(changed) : base.on(`data:changed:${what.slice(5)}`, changed));
  };
  /** A copy of `api` that notes what it reads; its traced() copies do too. */
  const tracking = (api: Api): Api => ({
    ...api,
    call(service: string, method: string, ...args: unknown[]) {
      if (service === "data" && (method === "list" || method === "get")) follow(`data:${String(args[0])}`);
      if (service === "settings" && method === "get") follow("settings");
      return api.call(service, method, ...args);
    },
    settings: {
      ...api.settings,
      get() {
        follow("settings");
        return api.settings.get();
      },
    },
    traced: () => tracking(api.traced()),
  });
  const reader = tracking(base);

  async function run() {
    if (running) return void (again = true);
    running = true;
    do {
      again = false;
      try {
        const value = await compute(reader);
        if (!stopped) draw(value);
      } catch (error) {
        // The view keeps what it last drew; the error goes to the trace, and a change that came meanwhile still runs.
        base.log(`A live view failed: ${error instanceof Error ? error.message : error}`, "error");
      }
    } while (again && !stopped);
    running = false;
  }
  function changed() {
    void run();
  }

  void run();
  return {
    refresh: () => void run(),
    stop() {
      stopped = true;
      for (const off of followed.values()) off();
      followed.clear();
    },
  };
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (value: unknown): string => {
  if (value === null || value === undefined || value === false) return "";
  if (Array.isArray(value)) return value.map(escape).join("");
  if (typeof value === "object" && (value as View).type === "html") return (value as { html: string }).html;
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
};

/** `html\`...\``: values are escaped, so a note titled "<b>" shows as text; nested `html` results and arrays of them go in as they are. */
function html(strings: TemplateStringsArray, ...values: unknown[]): View {
  let out = strings[0];
  values.forEach((value, i) => (out += escape(value) + strings[i + 1]));
  return { type: "html", html: out };
}

const ctx = api(() => activeTrace);
const log = ctx.log;

async function load(source: string) {
  // On a Node server the host gives a data: URL instead (src/server/isolate.ts); Node can't import blob: URLs.
  const moduleUrl = (globalThis as { __moduleUrl?: (source: string) => string }).__moduleUrl;
  const url = moduleUrl ? moduleUrl(source) : URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  lockdown();
  try {
    const module = await import(/* @vite-ignore */ url);
    const manifest = module.manifest as Manifest;
    if (!manifest?.id || !Array.isArray(manifest.permissions)) throw new Error("The module has no manifest");
    send({ t: "ready", manifest });
    await module.default(ctx);
  } catch (error) {
    send({ t: "failed", error: String(error instanceof Error ? error.message : error) });
  } finally {
    if (!moduleUrl) URL.revokeObjectURL(url);
  }
}

async function receive(message: KernelToPlugin) {
  switch (message.t) {
    case "hook": {
      const handler = handlers.get(message.listener);
      if (message.id === undefined) {
        try {
          traced(message.trace, (bound) => handler?.apply(bound, message.args));
        } catch (error) {
          log(String(error), "error");
        }
        return;
      }
      try {
        const value = await traced(message.trace, (bound) => handler?.apply(bound, message.args));
        send({ t: "hook:result", id: message.id, ok: true, value });
      } catch (error) {
        send({ t: "hook:result", id: message.id, ok: false, error: String(error) });
      }
      return;
    }
    case "event":
      if (message.action === "settings:changed") {
        for (const handler of settingsHandlers) traced(message.trace, (bound) => handler.call(bound, message.value as Record<string, unknown>));
        return;
      }
      if (message.action === "kernel:denied") log(`Denied: ${message.value}`, "error");
      for (const handler of eventHandlers) traced(message.trace, (bound) => handler.call(bound, message.action, message.value));
      return;
    case "canvas":
      canvasHandlers.get(message.id)?.(message.canvas, message.theme);
      return;
    case "canvas:theme":
      for (const handler of themeHandlers) handler(message.theme);
      return;
    case "result": {
      const waiting = calls.get(message.id);
      calls.delete(message.id);
      if (message.ok) waiting?.resolve(message.value);
      else waiting?.reject(Object.assign(new Error(message.error), message.gone ? { name: GONE } : {}));
      return;
    }
  }
}

// A plugin's uncaught errors, from timers and promises nobody awaited, go to the trace as its own errors.
self.addEventListener("error", (e) => port && ctx.log(String(e.message ?? e), "error"));
self.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  // A call left unanswered because the service's provider stopped or is off (a person's doing, not this plugin's
  // mistake): a note, saying which call and which plugin, and no error on the page.
  if (reason instanceof Error && reason.name === GONE) {
    e.preventDefault();
    if (port) ctx.log(reason.message);
    return;
  }
  if (port) ctx.log(`Unhandled: ${reason instanceof Error ? reason.message : String(reason)}`, "error");
});

self.onmessage = (e: MessageEvent<{ t: "init"; source: string }>) => {
  if (e.data?.t !== "init") return;
  port = e.ports[0];
  port.onmessage = (m: MessageEvent<KernelToPlugin>) => void receive(m.data);
  port.start();
  void load(e.data.source);
};
