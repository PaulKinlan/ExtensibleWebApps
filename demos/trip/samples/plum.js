// Plum: a theme. A plugin with the ui:theme permission sets the platform's
// design tokens for the whole app from its manifest, so every plugin's view
// and the page itself change together. light-dark() gives a light and a dark
// value. The page's own styles still win: an app that sets --accent keeps it.
// It draws nothing, so it has no code to speak of.

export const manifest = {
  id: "plum",
  name: "Plum theme",
  description: "Plum accents and rounder corners for the whole app.",
  version: "1.0.0",
  permissions: ["ui:theme"],
  theme: {
    "--accent": "light-dark(#7c3aed, #c4b5fd)",
    "--accent-fg": "light-dark(#ffffff, #1e1033)",
    "--bg-2": "light-dark(#f5f0fb, #221b2b)",
    "--radius": "10px",
    "--radius-lg": "16px",
  },
};

export default function () {}
