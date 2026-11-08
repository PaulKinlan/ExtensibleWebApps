// Forest: a theme. Mossy surfaces and a pine accent, light and dark.

export const manifest = {
  id: "forest",
  name: "Forest theme",
  description: "Moss and pine, light and dark.",
  version: "1.0.0",
  permissions: ["ui:theme"],
  theme: {
    "--bg": "light-dark(#f3f5ef, #0f1611)",
    "--bg-2": "light-dark(#e7ece0, #162019)",
    "--surface": "light-dark(#fbfcf8, #1a261d)",
    "--fg": "light-dark(#1b2a1f, #e4efe4)",
    "--fg-2": "light-dark(#5b6e5f, #9fb5a3)",
    "--border": "light-dark(#d6dfcf, #2a3a2e)",
    "--accent": "light-dark(#2f7d4f, #6fcf97)",
    "--accent-fg": "light-dark(#ffffff, #0f1611)",
  },
};

export default function () {}
