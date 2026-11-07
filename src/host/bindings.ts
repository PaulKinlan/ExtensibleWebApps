// The host's side of collection bindings. A bound element (ui-table,
// ui-form) asks for a collection on behalf of the plugin whose view it sits
// in; the kernel checks that plugin's rights, sends the records, and sends
// them again whenever the collection changes. Saves and deletes go back the
// same way. The elements ask with DOM events (see elements/bound-element.js),
// answered by answerElements() at the end of this file.

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

/**
 * Answers the events bound elements send. The host works out the plugin from
 * where the element sits, so an element can't act for a different plugin.
 */
export function answerElements(root: Document): void {
  type Asked = CustomEvent<Record<string, unknown>>;
  root.addEventListener("ui-owner", (e) => {
    (e as Asked).detail.owner = ownerOf(e.target as Element);
  });
  root.addEventListener("ui-bind", (e) => {
    const { detail } = e as Asked;
    const owner = ownerOf(e.target as Element);
    if (owner) detail.unbind = bind(owner, String(detail.collection), detail.listener as (message: Bound) => void);
  });
  root.addEventListener("ui-save", (e) => {
    const { detail } = e as Asked;
    const owner = ownerOf(e.target as Element);
    if (owner) detail.result = saveRecord(owner, String(detail.collection), detail.recordId as string | undefined, detail.fields as Record<string, unknown> | null);
  });
}
