// The `ctx` a sandboxed plugin gets, as a type. The runtime implements it;
// the kernel's API reference documents it against this type, so a member
// added here can't go undocumented.

import type { Slot, View } from "./protocol";

/**
 * The API a sandboxed plugin gets. `trace` says which trace its calls carry:
 * the plugin's own `ctx` uses whatever is active, so a call in the
 * synchronous part of a handler is traced. Workers have no async context, so
 * after an `await` nothing is active; `ctx.traced()` (or `this` in a
 * `function` handler) returns a copy pinned to the trace being handled.
 */
export interface Api {
  on(name: string, handler: (...args: any[]) => unknown): () => void;
  call(service: string, method: string, ...args: unknown[]): Promise<unknown>;
  ui: {
    render(slot: Slot, key: string, view: View | null, order?: number): void;
    onEvent(handler: (action: string, value: unknown) => void): () => void;
    onCanvas(id: string, handler: (canvas: OffscreenCanvas) => void): void;
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
  traced(): Api;
  log(text: string, level?: "info" | "error"): void;
}

/** Every callable member of `Api`, by its dotted name: "on", "ui.render", ... */
export type ApiMember<T = Api, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends (...args: any[]) => any ? `${P}${K}` : ApiMember<T[K], `${P}${K}.`>;
}[keyof T & string];
