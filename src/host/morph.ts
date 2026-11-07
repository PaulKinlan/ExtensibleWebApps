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

/**
 * What the HTML says a control holds: its value attribute, checked, the
 * selected options. Form state lives in properties, so the person's edits are
 * kept unless the plugin changes what it declares; only then is the new
 * value applied.
 */
function declared(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) return el.type === "checkbox" || el.type === "radio" ? String(el.hasAttribute("checked")) : (el.getAttribute("value") ?? "");
  if (el instanceof HTMLTextAreaElement) return el.textContent ?? "";
  if (el instanceof HTMLSelectElement) return JSON.stringify([...el.querySelectorAll("option")].filter((o) => o.hasAttribute("selected")).map((o) => o.value));
  return undefined;
}

function apply(el: Element, value: string): void {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") el.checked = value === "true";
    else el.value = value;
  } else if (el instanceof HTMLTextAreaElement) {
    el.value = value;
  } else if (el instanceof HTMLSelectElement) {
    const chosen = new Set(JSON.parse(value) as string[]);
    for (const option of el.options) option.selected = chosen.has(option.value);
    if (!chosen.size && !el.multiple) el.selectedIndex = el.options.length ? 0 : -1;
  }
}

/** Moves `node` before `ref` without losing focus, where the browser can. */
function move(parent: Node, node: Node, ref: Node | null): void {
  const moveBefore = (parent as Node & { moveBefore?: (node: Node, ref: Node | null) => void }).moveBefore;
  if (moveBefore && parent.isConnected) {
    try {
      moveBefore.call(parent, node, ref);
      return;
    } catch {
      // fall through to a plain move
    }
  }
  const active = document.activeElement;
  const inside = active && node.contains(active) ? (active as HTMLElement) : null;
  const selection = inside && (inside instanceof HTMLInputElement || inside instanceof HTMLTextAreaElement) ? [inside.selectionStart, inside.selectionEnd] : null;
  parent.insertBefore(node, ref);
  if (inside) {
    inside.focus({ preventScroll: true });
    if (selection) {
      try {
        (inside as HTMLInputElement).setSelectionRange(selection[0], selection[1]);
      } catch {
        // some input types have no selection
      }
    }
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
  // Read both declared values before the children move from `to` into `from`.
  const before = declared(from);
  const after = declared(to);
  patchAttributes(from, to);
  if (open !== undefined) (from as HTMLDetailsElement).open = open;
  if (from instanceof HTMLTextAreaElement) {
    if (before !== after) {
      from.textContent = after ?? "";
      if (from !== document.activeElement) from.value = after ?? "";
    }
    return;
  }
  morphChildren(from, to);
  if (after !== undefined && before !== after && from !== document.activeElement) apply(from, after);
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
      if (match !== cursor) move(from, match, cursor);
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
