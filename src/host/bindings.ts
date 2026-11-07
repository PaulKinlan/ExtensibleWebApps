// The host's side of collection bindings. A bound component asks for a
// collection on behalf of the plugin whose view it sits in; the kernel checks
// that plugin's rights, sends the records, and sends them again whenever the
// collection changes. Saves and deletes go back the same way.

import type { HostToKernel, KernelToHost } from "../shared/protocol";

export type Bound = Extract<KernelToHost, { t: "bound" }>;
export type RecordResult = Extract<KernelToHost, { t: "record:result" }>;

let send: (message: HostToKernel) => void = () => {};
let trace: () => string = () => "";
let next = 0;
const listeners = new Map<string, (message: Bound) => void>();
const waiting = new Map<string, (result: RecordResult) => void>();

export function connectBindings(sender: (message: HostToKernel) => void, newTrace: () => string): void {
  send = sender;
  trace = newTrace;
}

export function receive(message: KernelToHost): boolean {
  if (message.t === "bound") {
    listeners.get(message.id)?.(message);
    return true;
  }
  if (message.t === "record:result") {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return true;
  }
  return false;
}

/**
 * Which plugin drew each view entry. Kept here rather than in an attribute,
 * because a plugin's HTML may carry any `data-*` attribute and must not be
 * able to claim another plugin's rights.
 */
const owners = new WeakMap<Element, string>();
export const setOwner = (entry: Element, owner: string) => void owners.set(entry, owner);

/** The plugin that drew `el`, from the view entry it sits in. */
export function ownerOf(el: Element): string | undefined {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const owner = owners.get(node);
    if (owner) return owner;
  }
  return undefined;
}

export function bind(owner: string, collection: string, listener: (message: Bound) => void): () => void {
  const id = `b${++next}`;
  listeners.set(id, listener);
  send({ t: "bind", id, owner, collection });
  return () => {
    listeners.delete(id);
    send({ t: "unbind", id });
  };
}

/** Saves (fields) or deletes (null) a record for `owner`. */
export function saveRecord(owner: string, collection: string, recordId: string | undefined, fields: Record<string, unknown> | null): Promise<RecordResult> {
  const id = `r${++next}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ t: "record", id, owner, collection, recordId, fields, trace: trace() });
  });
}
