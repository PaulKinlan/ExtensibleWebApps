// Midnight: a theme a person can add from Customize, deep blue at night
// and a cool blue-grey by day. A plugin with the
// ui:theme permission sets the design tokens for the whole app from its
// manifest. The board's own colours are set in the platform layer of
// app.html (see there), so a theme like this one, in the plugins layer,
// wins over them, while anything the page sets outside a layer still
// wins over the theme.

export const manifest = {
  id: "midnight",
  name: "Midnight theme",
  description: "Deep blue surfaces and an electric accent at night, cool blue-grey by day.",
  version: "1.0.0",
  permissions: ["ui:theme"],
  theme: {
    "--bg": "light-dark(#eef1f8, #0b1020)",
    "--bg-2": "light-dark(#e3e8f4, #121a33)",
    "--surface": "light-dark(#ffffff, #161f3d)",
    "--fg": "light-dark(#111a33, #e6ebff)",
    "--fg-2": "light-dark(#56618a, #9aa6d1)",
    "--border": "light-dark(#d5dcef, #26325c)",
    "--accent": "light-dark(#3355ff, #7c9cff)",
    "--accent-fg": "light-dark(#ffffff, #0b1020)",
    "--radius": "14px",
    "--radius-lg": "20px",
  },
};

export default function () {}
