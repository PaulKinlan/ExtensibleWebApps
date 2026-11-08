// Sunset: a theme. It sets the design tokens from its manifest, so the
// machine's surfaces, borders and accent change together. The pads keep
// their own colours: those belong to the sequencer's template.

export const manifest = {
  id: "sunset",
  name: "Sunset theme",
  description: "Warm plum surfaces and a coral accent.",
  version: "1.0.0",
  permissions: ["ui:theme"],
  theme: {
    "--bg": "#1a0f1f",
    "--bg-2": "#26142b",
    "--surface": "#2e1733",
    "--fg": "#ffe9e1",
    "--fg-2": "#d3a9b8",
    "--border": "#4a2550",
    "--accent": "#ff8a65",
    "--accent-fg": "#1a0f1f",
  },
};

export default function () {}
