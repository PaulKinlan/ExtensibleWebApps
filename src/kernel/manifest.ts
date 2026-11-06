// Reads a plugin's manifest from its source without running it, so the
// kernel knows what a plugin asks for before any of its code executes (the
// Markdown editor does the same). `export const manifest = { ... }` must be
// the module's first statement, with only comments before it, so a manifest
// in a comment or a string can't stand in for the real one. Its value must be
// a plain literal: strings, numbers, booleans, null, arrays and objects, with
// optional comments and trailing commas, and nothing after it but the end of
// the statement. Anything else is refused.

import type { Manifest } from "../shared/protocol";

export class ManifestError extends Error {}

const ID = /^[a-z][a-z0-9-]{0,63}$/;

export function readManifest(source: string): Manifest {
  const parser = new LiteralParser(source, 0);
  parser.declaration();
  const value = parser.value();
  parser.statementEnd();
  return validate(value);
}

function validate(value: unknown): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManifestError("The manifest must be an object");
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || !ID.test(m.id)) throw new ManifestError("`id` must be lowercase letters, digits and dashes, starting with a letter");
  if (typeof m.name !== "string" || !m.name) throw new ManifestError("`name` must be a string");
  if (!Array.isArray(m.permissions) || m.permissions.some((p) => typeof p !== "string")) throw new ManifestError("`permissions` must be a list of strings");
  if (m.scope !== undefined && m.scope !== "shared" && m.scope !== "tab") throw new ManifestError('`scope` must be "shared" or "tab"');
  if (m.order !== undefined && typeof m.order !== "number") throw new ManifestError("`order` must be a number");
  if (m.settings !== undefined) validateSettings(m.settings);
  return m as unknown as Manifest;
}

function validateSettings(settings: unknown) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new ManifestError("`settings` must be an object");
  const entries = Object.entries(settings as Record<string, unknown>);
  if (entries.length > 30) throw new ManifestError("At most 30 settings");
  for (const [key, spec] of entries) {
    const s = spec as Record<string, unknown>;
    if (!s || !["string", "number", "boolean"].includes(s.type as string)) throw new ManifestError(`Setting ${key} needs a type of string, number or boolean`);
    if (s.enum !== undefined && (!Array.isArray(s.enum) || s.type !== "string")) throw new ManifestError(`Setting ${key}: enum is a list, for string settings`);
  }
}

class LiteralParser {
  constructor(
    private s: string,
    private i: number,
  ) {}

  private fail(what: string): never {
    const line = this.s.slice(0, this.i).split("\n").length;
    throw new ManifestError(`The manifest must be a plain literal: ${what} on line ${line}`);
  }

  private space() {
    for (;;) {
      const c = this.s[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else if (this.s.startsWith("//", this.i)) this.i = this.s.indexOf("\n", this.i) === -1 ? this.s.length : this.s.indexOf("\n", this.i);
      else if (this.s.startsWith("/*", this.i)) {
        const end = this.s.indexOf("*/", this.i + 2);
        if (end === -1) this.fail("an unclosed comment");
        this.i = end + 2;
      } else return;
    }
  }

  /** `export const manifest =`, as the first statement. */
  declaration() {
    this.space();
    const m = /^export\s+const\s+manifest\s*=/.exec(this.s.slice(this.i, this.i + 200));
    if (!m) throw new ManifestError("The module must start with `export const manifest = { ... }` (only comments may come before it)");
    this.i += m[0].length;
  }

  /** The literal must end the statement: a `;`, the end of the file, or a new line that starts a new statement. */
  statementEnd() {
    const before = this.i;
    this.space();
    const c = this.s[this.i];
    if (c === undefined || c === ";") return;
    const newLine = /[\n\r]/.test(this.s.slice(before, this.i));
    if (newLine && /[A-Za-z_$]/.test(c) && !/^(in|instanceof)\b/.test(this.s.slice(this.i, this.i + 11))) return;
    this.fail(`${JSON.stringify(c)} after the manifest`);
  }

  value(): unknown {
    this.space();
    const c = this.s[this.i];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'") return this.string();
    if (c === "-" || (c >= "0" && c <= "9")) return this.number();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (this.s.startsWith(word, this.i) && !/[\w$]/.test(this.s[this.i + word.length] ?? "")) {
        this.i += word.length;
        return v;
      }
    }
    return this.fail(`unexpected ${c === undefined ? "end of file" : JSON.stringify(c)}`);
  }

  private object() {
    const out: Record<string, unknown> = {};
    this.i++;
    for (;;) {
      this.space();
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      const key = this.key();
      if (key === "__proto__" || key === "constructor" || key === "prototype") this.fail(`the key ${key}`);
      this.space();
      if (this.s[this.i] !== ":") this.fail("a missing `:`");
      this.i++;
      out[key] = this.value();
      this.space();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "}") this.fail("a missing `,` or `}`");
    }
  }

  private key(): string {
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.string();
    const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 100));
    if (!m) return this.fail("a key that is not a name or a string");
    this.i += m[0].length;
    return m[0];
  }

  private array() {
    const out: unknown[] = [];
    this.i++;
    for (;;) {
      this.space();
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.space();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]") this.fail("a missing `,` or `]`");
    }
  }

  private string(): string {
    const quote = this.s[this.i++];
    let out = "";
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined || c === "\n") this.fail("an unclosed string");
      if (c === quote) return out;
      if (c === "\\") {
        const e = this.s[this.i++];
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "/": "/" };
        if (e === "u") {
          const hex = this.s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("a bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
        } else if (e in map) out += map[e];
        else this.fail(`the escape \\${e}`);
      } else out += c;
    }
  }

  private number(): number {
    const m = /^-?(?:0|[1-9][\d_]*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.s.slice(this.i, this.i + 40));
    if (!m) return this.fail("a bad number");
    this.i += m[0].length;
    return Number(m[0].replace(/_/g, ""));
  }
}
