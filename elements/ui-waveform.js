// @ts-check
// ui-waveform: see ui-waveform.html for what it does and its attributes.
//
// The element draws and picks; the plugin that drew it keeps the sound. A
// pick goes back as a `ui-action` event, which the host sends to that plugin
// like a click, and the plugin answers by drawing the view again with a new
// `select`.

const STEP = 0.1;

export default class UiWaveform extends HTMLElement {
  static observedAttributes = ["peaks", "duration", "select", "playing", "label"];
  /** @type {HTMLTemplateElement | undefined} set by the host from ui-waveform.html */
  static template;

  /** @type {number[]} */
  peaks = [];
  /** The selection in seconds, as the person last left it or the plugin last set it. */
  from = 0;
  to = 0;
  /** @type {{ at: number, from: number, to: number } | undefined} */
  playing;
  /** @type {number | undefined} */
  frame;
  /** @type {number | undefined} where a drag started, in seconds */
  anchor;
  /**
   * The keyboard's ends of the pick: Shift and an arrow move `keyCursor` and leave `keyAnchor` where it is, on
   * whichever side of it the cursor goes. Unset until a key moves them, and again after a drag or a new `select`.
   * @type {number | undefined}
   */
  keyAnchor;
  /** @type {number | undefined} */
  keyCursor;
  /**
   * The picks sent lately, newest last. The plugin echoes each back as `select`, and an echo of an older one can
   * come after a newer pick (keys pressed fast); it is ignored rather than moving the pick back.
   * @type {{ from: number, to: number, at: number }[]}
   */
  sent = [];

  /** The focusable part inside, which carries the slider's role and values. */
  get surface() {
    return /** @type {HTMLElement | null | undefined} */ (this.shadowRoot?.querySelector(".surface"));
  }

  get duration() {
    return Math.max(0, Number(this.getAttribute("duration")) || 0);
  }

  connectedCallback() {
    if (this.shadowRoot) return this.draw();
    const template = /** @type {typeof UiWaveform} */ (this.constructor).template;
    if (!template) return;
    const root = this.attachShadow({ mode: "open" });
    root.append(document.importNode(template.content, true));
    new ResizeObserver(() => this.draw()).observe(this);
    this.addEventListener("pointerdown", (e) => {
      if (!this.duration) return;
      this.surface?.focus({ preventScroll: true });
      this.setPointerCapture(e.pointerId);
      this.keyAnchor = this.keyCursor = undefined;
      this.anchor = this.at(e.clientX);
      this.pick(this.anchor, this.anchor, false);
    });
    this.addEventListener("pointermove", (e) => {
      if (this.anchor === undefined) return;
      this.pick(this.anchor, this.at(e.clientX), false);
    });
    const release = (/** @type {PointerEvent} */ e) => {
      if (this.anchor === undefined) return;
      const anchor = this.anchor;
      this.anchor = undefined;
      this.pick(anchor, this.at(e.clientX), true);
    };
    this.addEventListener("pointerup", release);
    this.addEventListener("pointercancel", release);
    this.addEventListener("keydown", (e) => {
      if (!this.duration) return;
      const cursor = this.keyCursor ?? this.to;
      const anchor = this.keyAnchor ?? (cursor === this.to ? this.from : this.to);
      let next;
      if (e.key === "ArrowLeft") next = cursor - STEP;
      else if (e.key === "ArrowRight") next = cursor + STEP;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = this.duration;
      else if (e.key === "Escape") return void (e.preventDefault(), (this.keyAnchor = this.keyCursor = undefined), this.pick(0, 0, true));
      else return;
      e.preventDefault();
      next = this.clamp(next);
      this.keyAnchor = e.shiftKey ? anchor : next;
      this.keyCursor = next;
      this.pick(this.keyAnchor, next, true);
    });
    this.attributeChangedCallback();
  }

  disconnectedCallback() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }

  attributeChangedCallback() {
    this.peaks = (this.getAttribute("peaks") ?? "")
      .split(",")
      .map(Number)
      .filter((n) => Number.isFinite(n));
    // The plugin's selection, unless the person is dragging one now.
    if (this.anchor === undefined) {
      const [from = 0, to = from] = (this.getAttribute("select") ?? "").split(",").map(Number);
      const [a, b] = [this.clamp(from), this.clamp(to)];
      const near = (/** @type {{ from: number, to: number }} */ p) => Math.abs(p.from - a) < 0.001 && Math.abs(p.to - b) < 0.001;
      this.sent = this.sent.filter((p) => Date.now() - p.at < 2000);
      const latest = this.sent.length > 0 && near(this.sent[this.sent.length - 1]);
      const stale = !latest && this.sent.some(near);
      if (latest) this.sent = [];
      if (!stale) {
        // A pick the plugin made itself (not the echo of the person's) starts the keyboard afresh.
        if (Math.abs(a - this.from) > 0.001 || Math.abs(b - this.to) > 0.001) this.keyAnchor = this.keyCursor = undefined;
        this.from = a;
        this.to = b;
      }
    }
    const [at, from, to] = (this.getAttribute("playing") ?? "").split(",").map(Number);
    this.playing = Number.isFinite(at) && Number.isFinite(from) && Number.isFinite(to) ? { at, from, to } : undefined;
    const surface = this.surface;
    if (surface) {
      surface.setAttribute("aria-label", this.getAttribute("label") || "Waveform");
      surface.setAttribute("aria-valuemin", "0");
      surface.setAttribute("aria-valuemax", String(this.duration));
      surface.setAttribute("aria-valuenow", String(this.to));
      surface.setAttribute("aria-valuetext", this.describe());
    }
    this.draw();
    if (this.playing && !this.frame) this.tick();
  }

  /** @param {number} s */
  clamp(s) {
    return Math.min(Math.max(Number.isFinite(s) ? s : 0, 0), this.duration);
  }

  /** The time under a point on screen, in seconds. @param {number} x */
  at(x) {
    const box = this.getBoundingClientRect();
    return this.clamp(((x - box.left) / Math.max(1, box.width)) * this.duration);
  }

  /**
   * The person picked from `a` to `b`: draw it, and when they let go, tell the plugin.
   * @param {number} a @param {number} b @param {boolean} done
   */
  pick(a, b, done) {
    this.from = this.clamp(Math.min(a, b));
    this.to = this.clamp(Math.max(a, b));
    this.draw();
    if (!done) return;
    this.surface?.setAttribute("aria-valuetext", this.describe());
    const action = this.getAttribute("action");
    const round = (/** @type {number} */ s) => Math.round(s * 1000) / 1000;
    if (!action) return;
    this.sent = [...this.sent.slice(-15), { from: round(this.from), to: round(this.to), at: Date.now() }];
    this.dispatchEvent(new CustomEvent("ui-action", { bubbles: true, composed: true, detail: { action, value: { from: round(this.from), to: round(this.to) } } }));
  }

  describe() {
    const f = (/** @type {number} */ s) => `${s.toFixed(2)} s`;
    return this.to > this.from ? `${f(this.from)} to ${f(this.to)} picked, of ${f(this.duration)}` : `Cursor at ${f(this.to)}, of ${f(this.duration)}`;
  }

  /** Keeps the playhead moving while something plays. */
  tick() {
    this.frame = undefined;
    if (!this.playing || !this.isConnected) return this.draw();
    this.draw();
    const end = this.playing.at + (this.playing.to - this.playing.from) * 1000;
    if (Date.now() < end + 100) this.frame = requestAnimationFrame(() => this.tick());
  }

  /** @param {string} name */
  colour(name) {
    const probe = this.shadowRoot?.querySelector(`.probe-${name}`);
    return probe ? getComputedStyle(probe).color : "#888";
  }

  draw() {
    const root = this.shadowRoot;
    const canvas = /** @type {HTMLCanvasElement | null | undefined} */ (root?.querySelector("canvas"));
    if (!root || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    const g = canvas.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, width, height);
    const middle = height / 2;
    const duration = this.duration;
    const x = (/** @type {number} */ s) => (duration ? (s / duration) * width : 0);

    // The selection, under the wave.
    const accent = this.colour("accent");
    if (this.to > this.from) {
      g.fillStyle = accent;
      g.globalAlpha = 0.18;
      g.fillRect(x(this.from), 0, Math.max(1, x(this.to) - x(this.from)), height);
      g.globalAlpha = 1;
    }

    // The wave: a column for each pair of peaks, stretched to the width.
    const pairs = Math.floor(this.peaks.length / 2);
    g.fillStyle = this.colour("wave");
    g.fillRect(0, middle - 0.5 * dpr, width, Math.max(1, dpr));
    if (pairs) {
      const column = width / pairs;
      for (let i = 0; i < pairs; i++) {
        const low = Math.max(-100, Math.min(100, this.peaks[i * 2]));
        const high = Math.max(-100, Math.min(100, this.peaks[i * 2 + 1]));
        const left = i * column;
        const inside = duration && left >= x(this.from) && left <= x(this.to) && this.to > this.from;
        g.fillStyle = inside ? accent : this.colour("wave");
        const top = middle - (high / 100) * (middle - 4 * dpr);
        const bottom = middle - (low / 100) * (middle - 4 * dpr);
        g.fillRect(left, top, Math.max(1, column - (column > 3 ? 1 : 0)), Math.max(1, bottom - top));
      }
    }

    // The cursor, or the selection's edges.
    g.fillStyle = accent;
    g.fillRect(x(this.from) - dpr / 2, 0, dpr * 1.5, height);
    if (this.to > this.from) g.fillRect(x(this.to) - dpr / 2, 0, dpr * 1.5, height);

    // The playhead.
    let now = this.to;
    if (this.playing) {
      const played = (Date.now() - this.playing.at) / 1000;
      if (played >= 0 && played <= this.playing.to - this.playing.from) {
        now = this.playing.from + played;
        g.fillStyle = this.colour("fg");
        g.fillRect(x(now) - dpr, 0, dpr * 2, height);
      }
    }
    const time = root.querySelector(".time");
    if (time) time.textContent = duration ? `${now.toFixed(2)} / ${duration.toFixed(2)} s` : "";
  }
}
