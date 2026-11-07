// Updates a drawn view in place from a freshly built one, so an update keeps
// what the person is doing: focus, a half-typed value, a scroll position, an
// open <details>. Children are matched by `key` when they have one, otherwise
// by position and tag; whatever matches is patched, the rest is replaced.

const keyOf = (node: Node) => (node instanceof Element ? node.getAttribute("key") : null);

function same(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (!(a instanceof Element) || !(b instanceof Element)) return true;
  if (a.localName !== b.localName) return false;
  if (a.localName === "canvas") return a.getAttribute("data-canvas") === b.getAttribute("data-canvas");
  return keyOf(a) === keyOf(b);
}

function patchAttributes(from: Element, to: Element): void {
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
}

/** Form state lives in properties, not attributes; carry it over unless the person is using the control. */
function patchControl(from: Element, to: Element): void {
  if (from === document.activeElement) return;
  if (from instanceof HTMLInputElement && to instanceof HTMLInputElement) {
    if (from.type === "checkbox" || from.type === "radio") from.checked = to.hasAttribute("checked");
    else from.value = to.getAttribute("value") ?? "";
  } else if (from instanceof HTMLTextAreaElement && to instanceof HTMLTextAreaElement) {
    from.value = to.value;
  } else if (from instanceof HTMLSelectElement && to instanceof HTMLSelectElement) {
    queueMicrotask(() => (from.value = to.value));
  }
}

function patch(from: Node, to: Node): void {
  if (!(from instanceof Element) || !(to instanceof Element)) {
    if (from.textContent !== to.textContent) from.textContent = to.textContent;
    return;
  }
  // A live canvas belongs to a worker; leave it alone.
  if (from.localName === "canvas") return;
  // An open <details> stays as the person left it.
  const open = from instanceof HTMLDetailsElement ? from.open : undefined;
  patchAttributes(from, to);
  if (open !== undefined) (from as HTMLDetailsElement).open = open;
  patchControl(from, to);
  if (from instanceof HTMLTextAreaElement) return;
  morphChildren(from, to);
}

/** Makes `from`'s children match `to`'s, reusing what it can. */
export function morphChildren(from: Node, to: Node): void {
  const keyed = new Map<string, Node>();
  for (const child of from.childNodes) {
    const key = keyOf(child);
    if (key !== null) keyed.set(key, child);
  }
  let cursor = from.firstChild;
  for (const next of [...to.childNodes]) {
    const key = keyOf(next);
    let match: Node | null = null;
    if (key !== null) {
      const found = keyed.get(key);
      if (found && same(found, next)) {
        match = found;
        keyed.delete(key);
      }
    } else if (cursor && keyOf(cursor) === null && same(cursor, next)) {
      match = cursor;
    }
    if (match) {
      if (match !== cursor) from.insertBefore(match, cursor);
      else cursor = cursor.nextSibling;
      patch(match, next);
    } else {
      from.insertBefore(next, cursor);
    }
  }
  while (cursor) {
    const next = cursor.nextSibling;
    from.removeChild(cursor);
    cursor = next;
  }
}
