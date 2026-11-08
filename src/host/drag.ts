// Drag and drop in views. A plugin marks what can be picked up and where it
// can go, in its HTML, and hears a drop as an event like a click:
//
//   <li data-drag="card-7">…</li>                 can be picked up (the host makes it draggable)
//   <ul data-drop="move" data-value="doing">…</ul> a place to drop it
//
// Dropping card-7 on that list sends the action `move` with
// { item: "card-7", value: "doing", before: "card-9" }: `before` is the item
// it was dropped on, when there is one, so a list can be put in order.
//
// A drag stays inside one plugin's view: an item from another plugin's view,
// another tab or another app is never dropped here, and nothing else is read
// from what was dragged. While something is dragged, the host marks it
// `data-dragging`, and the place under it `data-over`, for the plugin's CSS;
// a redraw during the drag takes them off, and the next dragover puts them
// back. Dropping an item on itself does nothing.
//
// A drag needs a pointer, so a view that uses it should also offer the same
// move with a button or a command.

/** What is being dragged now, from which view entry. Only one drag happens at a time. */
let dragging: { entry: HTMLElement; item: string; token: string } | undefined;
/** The drag data's type: it carries the drag's token, so a drop is known to be this drag and not one from elsewhere. */
const TYPE = "application/x-ewa-drag";

/** Forgets the drag when it ends anywhere: a redraw may have taken its element out of the view, and a later drag from outside the page must not drop this one. */
function ended() {
  if (dragging) dragged(dragging.entry, dragging.item)?.removeAttribute("data-dragging");
  dragging = undefined;
}

/** The dragged item's element as the view has it now: a redraw may have replaced the one picked up. */
function dragged(entry: HTMLElement, item: string): Element | null {
  return entry.querySelector(`[data-drag="${CSS.escape(item)}"]`);
}
addEventListener("dragend", ended, true);
addEventListener("drop", () => queueMicrotask(ended));

/** Listens for drags in one view entry; `ours` says whether an event belongs to it, `send` reports a drop. */
export function listenDrag(entry: HTMLElement, ours: (e: Event) => boolean, send: (action: string, value: unknown) => void): void {
  const zoneOf = (e: Event) => {
    if (!ours(e) || dragging?.entry !== entry || !(e as DragEvent).dataTransfer?.types.includes(TYPE)) return undefined;
    const zone = (e.target as Element).closest("[data-drop]");
    return zone && entry.contains(zone) ? zone : undefined;
  };
  let over: Element | undefined;
  const leave = () => {
    over?.removeAttribute("data-over");
    over = undefined;
  };

  entry.addEventListener("dragstart", (e) => {
    if (!ours(e)) return;
    const el = (e.target as Element).closest?.("[data-drag]");
    if (!el || !entry.contains(el)) return;
    ended();
    dragging = { entry, item: el.getAttribute("data-drag") ?? "", token: crypto.randomUUID() };
    el.setAttribute("data-dragging", "");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Only a token, which says nothing about the view, and marks the drop as this drag's. A link or image
      // dragged brings its own formats (text/uri-list, text/html): those go first.
      e.dataTransfer.clearData();
      e.dataTransfer.setData(TYPE, dragging.token);
    }
  });
  entry.addEventListener("dragover", (e) => {
    const zone = zoneOf(e);
    if (!zone) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (zone !== over) leave();
    over = zone;
    // Set again on each dragover: a redraw since may have taken these off.
    if (!zone.hasAttribute("data-over")) zone.setAttribute("data-over", "");
    const el = dragging && dragged(entry, dragging.item);
    if (el && !el.hasAttribute("data-dragging")) el.setAttribute("data-dragging", "");
  });
  entry.addEventListener("dragleave", (e) => {
    if (over && !over.contains(e.relatedTarget as Node | null)) leave();
  });
  entry.addEventListener("drop", (e) => {
    const zone = zoneOf(e);
    leave();
    if (!zone || !dragging || e.dataTransfer?.getData(TYPE) !== dragging.token) return;
    e.preventDefault();
    const onto = (e.target as Element).closest("[data-drag]");
    // Put down where it was picked up: nothing moves.
    if (onto?.getAttribute("data-drag") === dragging.item) return;
    const before = onto && zone.contains(onto) ? onto.getAttribute("data-drag") : null;
    send(zone.getAttribute("data-drop")!, { item: dragging.item, value: zone.getAttribute("data-value") ?? undefined, ...(before !== null ? { before } : {}) });
  });
  entry.addEventListener("dragend", leave);
}
