// Holds each of the page's slots open at the size it had last time, while
// the page loads, so what is below a slot doesn't jump down as its plugins
// start drawing. Nothing has to be declared: the host measures each slot
// once its views settle, keeps the height in this browser (per app, slot
// name and rough window width), and on the next visit puts a spacer right
// after the slot until its views are as tall again. The spacer shrinks as
// they grow, inside the same frame (a ResizeObserver runs before paint), so
// the page below stays where it was.
//
// A slot lets go when its views reach the height, when nothing has changed
// in it for a moment, on the person's first click or key, or after a few
// seconds at most. A slot whose views are shorter than last time closes up
// then, once; the size it settles at is what the next visit holds.
//
// A slot is display: contents, so the spacer is a box in the slot's parent:
// it cancels the gap a flex parent would put before it, and a slot in a grid
// isn't held (an extra item would take a cell of its own).

/** How long a slot's views must stay the same before it is measured and let go. */
const QUIET = 1200;
/** The longest a slot is held, from when the host starts. */
const LONGEST = 6000;
/** Heights are kept for windows of about the same width: phones and desktops lay a slot out differently. */
const bucket = () => Math.round(innerWidth / 160);

type Held = { name: string; slot: HTMLElement; spacer?: HTMLElement; height: number; timer?: ReturnType<typeof setTimeout>; drawn: boolean; done: boolean };

export type Reserve = {
  /** A view was added to (or removed from) a container. */
  changed(container: HTMLElement): void;
  /** Watch a view's size: as it grows, the spacer after its slot shrinks. */
  observe(el: HTMLElement, container: HTMLElement): void;
};

export function reserveSlots(app: string, slots: HTMLElement[]): Reserve {
  const key = `ewa:slot-heights:${app}`;
  let kept: Record<string, number> = {};
  try {
    kept = JSON.parse(localStorage.getItem(key) ?? "{}") ?? {};
  } catch {
    // No storage (a private window, blocked site data): nothing is held.
  }
  const save = () => {
    try {
      localStorage.setItem(key, JSON.stringify(kept));
    } catch {
      // As above.
    }
  };
  const width = bucket();
  const held = new Map<HTMLElement, Held>();

  for (const slot of slots) {
    const name = slot.getAttribute("name") ?? "";
    const height = kept[`${name}@${width}`] ?? 0;
    const entry: Held = { name, slot, height, drawn: false, done: false };
    held.set(slot, entry);
    const parent = slot.parentElement;
    if (!height || !parent) continue;
    const style = getComputedStyle(parent);
    if (style.display.includes("grid")) continue;
    const spacer = document.createElement("span");
    spacer.className = "slot-reserve";
    spacer.setAttribute("aria-hidden", "true");
    spacer.style.display = "block";
    spacer.style.flex = "none";
    spacer.style.pointerEvents = "none";
    if (style.display.includes("flex")) {
      const row = !style.flexDirection.startsWith("column");
      const gap = parseFloat(row ? style.columnGap : style.rowGap) || 0;
      if (gap) spacer.style[row ? "marginInlineStart" : "marginBlockStart"] = `${-gap}px`;
      if (row) spacer.style.width = "0";
    }
    slot.after(spacer);
    entry.spacer = spacer;
    fit(entry);
  }

  /** The height of what a slot shows now: a slot has no box of its own, so measure what is in it. */
  function contentHeight(slot: HTMLElement): number {
    const range = document.createRange();
    range.selectNodeContents(slot);
    return range.getBoundingClientRect().height;
  }

  function fit(entry: Held) {
    if (!entry.spacer) return;
    const rest = entry.height - contentHeight(entry.slot);
    if (rest <= 1 && entry.drawn) return release(entry);
    entry.spacer.style.height = `${Math.max(0, rest)}px`;
  }

  function release(entry: Held) {
    entry.spacer?.remove();
    entry.spacer = undefined;
  }

  /** Measures a slot whose views have settled, for next time, and lets it go. */
  function settle(entry: Held) {
    if (entry.done) return;
    entry.done = true;
    release(entry);
    const height = Math.round(contentHeight(entry.slot));
    if (height) kept[`${entry.name}@${width}`] = height;
    else delete kept[`${entry.name}@${width}`];
    save();
  }

  /** Restarts a drawn slot's wait for its views to settle. */
  const unsettled = (entry: Held) => {
    if (!entry.drawn || entry.done) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => settle(entry), QUIET);
  };
  const slotOf = new WeakMap<Element, Held>();
  // A view that changes size (an element upgrading, an image loading) isn't settled yet; every spacer follows.
  const sizes = new ResizeObserver((records) => {
    for (const record of records) {
      const entry = slotOf.get(record.target);
      if (entry) unsettled(entry);
    }
    for (const entry of held.values()) fit(entry);
  });
  for (const entry of held.values())
    for (const child of entry.slot.children) {
      slotOf.set(child, entry);
      sizes.observe(child);
    }

  const releaseAll = () => {
    for (const entry of held.values()) release(entry);
  };
  addEventListener("pointerdown", releaseAll, { once: true, capture: true });
  addEventListener("keydown", releaseAll, { once: true, capture: true });
  setTimeout(() => {
    // A slot no plugin drew in isn't measured: it may be a plugin that is off, or still starting.
    for (const entry of held.values()) (entry.drawn ? settle(entry) : release(entry));
  }, LONGEST);

  return {
    changed(container) {
      const entry = held.get(container);
      if (!entry || entry.done) return;
      entry.drawn = container.querySelector(":scope > [data-key]") !== null;
      fit(entry);
      unsettled(entry);
    },
    observe(el, container) {
      const entry = held.get(container);
      if (!entry || entry.done) return;
      slotOf.set(el, entry);
      sizes.observe(el);
    },
  };
}
