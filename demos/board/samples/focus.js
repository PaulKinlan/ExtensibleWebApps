// Focus: a person's own plugin that hides the columns they don't need right
// now, Ideas and Shipped, leaving the work in flight. It's a transform: a
// place inside the board plugin's view (`in: "studio"`) that hides what it
// matches, with the permission ui:transform:studio. It draws nothing and
// has no code. Turning it off gives the board back as it was.

export const manifest = {
  id: "focus",
  name: "Focus",
  description: "Hides the Ideas and Shipped columns, so only the work in flight shows.",
  version: "1.0.0",
  permissions: ["ui", "ui:transform:studio"],
  places: {
    quiet: { in: "studio", at: ".column[data-column='ideas'], .column[data-column='done']", put: "hide", each: true },
  },
};

export default function () {}
