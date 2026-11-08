// The `ctx` a sandboxed plugin gets, as a type. The runtime implements it;
// the kernel's API reference documents it against this type, so a member
// added here can't go undocumented.

import type { CanvasTheme, Slot, View } from "./protocol";

/**
 * The API a sandboxed plugin gets. `trace` says which trace its calls carry:
 * the plugin's own `ctx` uses whatever is active, so a call in the
 * synchronous part of a handler is traced. Workers have no async context, so
 * after an `await` nothing is active; `ctx.traced()` (or `this` in a
 * `function` handler) returns a copy pinned to the trace being handled.
 */
/** What `ctx.ui.views(file)` returns. */
export interface Views {
  /** Draws the template `<template id>` from the file in a slot, filled with `data`. The key is the id unless given. */
  render(slot: Slot, id: string, data?: unknown, options?: { key?: string; order?: number }): void;
  /**
   * Draws the template with the data `compute` returns, and draws it again
   * whenever a collection or setting it read changes.
   */
  live(slot: Slot, id: string, compute: (ctx: Api) => unknown, options?: { key?: string; order?: number }): Live;
}

/** A view kept up to date by `live`. */
export interface Live {
  /** Computes and draws again now: after the plugin's own state changes. */
  refresh(): void;
  /** Stops following changes; the view stays as it is. */
  stop(): void;
}

export type RouteMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A request to a plugin's route: the path is absolute, `form` holds a form's fields or a JSON body. */
export interface RouteRequest {
  method: RouteMethod;
  path: string;
  query: Record<string, string>;
  form?: unknown;
}

/** What a route answers with: one of redirect (a 303), html (a page that runs no script), json or text, and an optional status. */
export interface RouteResponse {
  status?: number;
  redirect?: string;
  html?: string;
  json?: unknown;
  text?: string;
}

/** A command, as `ctx.commands.add` takes it. */
export interface CommandSpec {
  id: string;
  title: string;
  description?: string;
  /** Up to 3 shortcuts: "Mod+K" (Cmd on a Mac, Ctrl elsewhere), "Shift+N", "?". */
  keys?: string[];
  group?: string;
  /** What the handler takes, as an object schema; a palette shows only commands that need no arguments. */
  args?: unknown;
}

export interface Api {
  on(name: string, handler: (...args: any[]) => unknown): () => void;
  call(service: string, method: string, ...args: unknown[]): Promise<unknown>;
  /**
   * The hooks this plugin defines in its manifest's `hooks`: `emit("open", note)` tells the listeners of
   * `<id>:open`; `call("save", change)` runs a serial, bail or waterfall hook and gives back the answer.
   */
  hooks: {
    emit(key: string, value?: unknown): Promise<void>;
    call(key: string, value?: unknown): Promise<unknown>;
  };
  ui: {
    /** Draws a view: HTML (a string, or what `ui.html` returns), a JSON view, or null to remove it. */
    render(slot: Slot, key: string, view: View | string | null, order?: number): void;
    /** A tagged template: `ctx.ui.html\`<p>${name}</p>\`` escapes every value, and nests other `html` results as they are. */
    html(strings: TemplateStringsArray, ...values: unknown[]): View;
    /** Draws what `compute` returns (as `render` takes it), again whenever a collection or setting it read changes. */
    live(slot: Slot, key: string, compute: (ctx: Api) => unknown, order?: number): Live;
    /** The templates in an .html file next to the plugin: `views.render(slot, id, data)` draws one, filled with data. */
    views(file: string): Views;
    onEvent(handler: (action: string, value: unknown) => void): () => void;
    /** The OffscreenCanvas for a canvas view, with the page's theme: its colours resolved, its font, light or dark. */
    onCanvas(id: string, handler: (canvas: OffscreenCanvas, theme?: CanvasTheme) => void): void;
    /** The theme again, whenever it changes in a tab where the plugin has a canvas: redraw with it. */
    onTheme(handler: (theme: CanvasTheme) => void): () => void;
  };
  /** The plugin's own settings, from the form the shell builds out of its manifest. */
  settings: {
    get(): Promise<Record<string, unknown>>;
    onChange(handler: (values: Record<string, unknown>) => void): () => void;
  };
  /** The plugin's own data, kept with the app's data. Writing it needs no review. */
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<unknown>;
  };
  /**
   * Requests the plugin answers, for paths inside its own folder (only for plugins an app links).
   * `add("POST", "snooze", (request) => ({ redirect: "./" }))` answers a form posted to `snooze`.
   */
  routes: {
    add(method: RouteMethod, path: string, handler: (request: RouteRequest) => RouteResponse | undefined | Promise<RouteResponse | undefined>): () => void;
  };
  /**
   * Work done later, with the `schedule` permission: `every("digest", 3_600_000, handler)` runs the
   * handler once an hour, and `at("reminder", Date.parse("2026-12-01T09:00Z"), handler)` once. On a
   * space's server a job wakes the space when it comes due, even after a restart. In a browser it runs
   * only while the kernel is running. Names are the plugin's own; setting one again replaces it.
   */
  schedule: {
    every(name: string, ms: number, handler: () => unknown): () => void;
    at(name: string, when: number, handler: () => unknown): () => void;
    /** Stops a job, and forgets it. */
    cancel(name: string): Promise<void>;
  };
  /**
   * Things the person, or an agent, can do: a command palette lists them, their keys run them, and
   * `commands.run` runs them. `add({ id: "finish", title: "Mark what I'm reading as done", keys: ["Alt+D"] }, (args, { by }) => …)`.
   */
  commands: {
    add(command: CommandSpec, handler: (args: Record<string, unknown>, about: { by: string }) => unknown): () => void;
  };
  traced(): Api;
  log(text: string, level?: "info" | "error"): void;
}

/** Every callable member of `Api`, by its dotted name: "on", "ui.render", ... */
export type ApiMember<T = Api, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends (...args: any[]) => any ? `${P}${K}` : ApiMember<T[K], `${P}${K}.`>;
}[keyof T & string];
