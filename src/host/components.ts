// The host's own components: plain custom elements, no framework. Layout and
// styling come from design tokens (CSS custom properties in styles.css), so
// whatever a plugin builds looks like the rest of the app. A component that
// draws parts of its own does it in a shadow root, so updating a view (which
// only touches the light DOM) never clobbers them.

const GAPS: Record<string, string> = { "0": "0", "1": "var(--space-1)", "2": "var(--space-2)", "3": "var(--space-3)", "4": "var(--space-4)", "5": "var(--space-5)", "6": "var(--space-6)" };
const gap = (value: string | null, fallback = "3") => GAPS[value ?? fallback] ?? GAPS[fallback];
/** A CSS length a plugin may give, such as `12rem` or `240px`; anything else falls back. */
const length = (value: string | null, fallback: string) => (value && /^\d+(\.\d+)?(rem|px|em|ch|%)$/.test(value) ? value : fallback);

abstract class Shadowed extends HTMLElement {
  static get observedAttributes(): string[] {
    return [];
  }
  protected root = this.attachShadow({ mode: "open" });
  connectedCallback() {
    this.draw();
  }
  attributeChangedCallback() {
    if (this.isConnected) this.draw();
  }
  abstract draw(): void;
  /** Puts text into the shadow root without parsing it as HTML. */
  protected text(selector: string, value: string | null) {
    const el = this.root.querySelector(selector);
    if (el) el.textContent = value ?? "";
  }
}

class UiGrid extends Shadowed {
  static get observedAttributes() {
    return ["min", "gap"];
  }
  draw() {
    this.root.innerHTML = `<style>:host{display:grid;gap:${gap(this.getAttribute("gap"))};grid-template-columns:repeat(auto-fit,minmax(min(${length(this.getAttribute("min"), "12rem")},100%),1fr))}</style><slot></slot>`;
  }
}

class UiStat extends Shadowed {
  static get observedAttributes() {
    return ["label", "value", "delta", "tone"];
  }
  draw() {
    if (!this.root.firstChild) {
      this.root.innerHTML = `<style>
        :host{display:flex;flex-direction:column;gap:var(--space-1);padding:var(--space-3) var(--space-4);border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface)}
        .label{font-size:var(--text-sm);color:var(--fg-2)}
        .value{font-size:var(--text-2xl);font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-0.01em}
        .delta{font-size:var(--text-sm);font-variant-numeric:tabular-nums;color:var(--fg-2)}
        :host([tone=ok]) .delta{color:var(--ok)} :host([tone=danger]) .delta{color:var(--danger)} :host([tone=warn]) .delta{color:var(--warn)}
        .delta:empty{display:none}
      </style><span class="label"></span><span class="value"></span><span class="delta"></span><slot></slot>`;
    }
    this.text(".label", this.getAttribute("label"));
    this.text(".value", this.getAttribute("value"));
    this.text(".delta", this.getAttribute("delta"));
  }
}

class UiEmpty extends Shadowed {
  static get observedAttributes() {
    return ["heading"];
  }
  draw() {
    if (!this.root.firstChild) {
      this.root.innerHTML = `<style>
        :host{display:flex;flex-direction:column;align-items:center;text-align:center;gap:var(--space-2);padding:var(--space-6) var(--space-4);border:1px dashed var(--border);border-radius:var(--radius-lg);color:var(--fg-2)}
        h3{margin:0;font-size:var(--text-lg);color:var(--fg)}
        h3:empty{display:none}
      </style><h3></h3><slot></slot>`;
    }
    this.text("h3", this.getAttribute("heading"));
  }
}

/** Elements styled entirely by styles.css; defined so they count as known elements. */
class Plain extends HTMLElement {}

export function defineComponents(): void {
  const define = (name: string, cls: CustomElementConstructor) => customElements.get(name) ?? customElements.define(name, cls);
  define("ui-grid", UiGrid);
  define("ui-stat", UiStat);
  define("ui-empty", UiEmpty);
  for (const name of ["ui-stack", "ui-card", "ui-badge", "ui-toolbar", "ui-spacer"]) define(name, class extends Plain {});
}
