// Themes: a plugin with the `ui:theme` permission may set the platform's design
// tokens for the whole app, from its manifest:
//
//   theme: { "--accent": "light-dark(#7c3aed, #c4b5fd)", "--radius": "12px" }
//
// The host puts them in the plugins layer, above the platform's defaults and
// below the page's own styles, so the app's author still has the last word.
// Only the tokens below may be set, and only to plain values: nothing that
// loads a file or breaks out of the declaration. Shared by the kernel (which
// refuses a bad manifest) and the host (which applies the theme).

/** The tokens a theme may set, and what each is. The API reference prints this table. */
export const THEME_TOKENS: Record<string, string> = {
  "--bg": "The page's background",
  "--bg-2": "A second background, for headers and bands",
  "--surface": "Cards, dialogs and inputs",
  "--fg": "Text",
  "--fg-2": "Quieter text",
  "--border": "Lines and borders",
  "--accent": "Links, primary buttons, focus",
  "--accent-fg": "Text on the accent",
  "--ok": "Success",
  "--warn": "Warning",
  "--danger": "Errors and deleting",
  "--radius-sm": "Small corners",
  "--radius": "Corners",
  "--radius-lg": "Large corners",
  "--shadow-1": "The shadow under raised things",
  "--font": "The typeface",
  "--mono": "The fixed-width typeface",
};

/** The longest value a token may have. */
const MAX = 200;

/** Why a token's value can't be used, or undefined if it can. `light-dark(a, b)` gives light and dark values. */
export function badThemeValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return "a value is a non-empty string";
  if (value.length > MAX) return `a value is at most ${MAX} characters`;
  if (/[;{}<>@!\\]/.test(value)) return "a value can't hold ; { } < > @ ! or \\";
  if (/\b(url|src|image-set|image|element|cross-fade|attr|env)\s*\(/i.test(value)) return "a value can't load anything or read attributes";
  // Nothing left open to swallow what follows it: no comments, and every quote and bracket closed.
  if (/\/\*|\*\//.test(value)) return "a value can't hold comments";
  const open: string[] = [];
  let quote = "";
  for (const c of value) {
    if (quote) quote = c === quote ? "" : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") open.push(c);
    else if ((c === ")" && open.pop() !== "(") || (c === "]" && open.pop() !== "[")) return "a value's brackets must match";
  }
  if (quote || open.length) return "a value's quotes and brackets must close";
  return undefined;
}

/** The CSS for a list of themes, later ones winning, or "" for none. Anything not allowed is left out. */
export function themeCss(themes: Record<string, string>[]): string {
  const lines: string[] = [];
  for (const theme of themes)
    for (const [token, value] of Object.entries(theme)) if (token in THEME_TOKENS && !badThemeValue(value)) lines.push(`  ${token}: ${value};`);
  return lines.length ? `@layer plugins {\n:root {\n${lines.join("\n")}\n}\n}\n` : "";
}
