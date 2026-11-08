// Drums only: a person's own plugin that hides the two melodic rows, bass and
// bell, for when you want to think about rhythm. A transform with no code:
// a place inside the sequencer's view that hides what it matches.

export const manifest = {
  id: "drums-only",
  name: "Drums only",
  description: "Hides the bass and bell rows.",
  version: "1.0.0",
  permissions: ["ui", "ui:transform:sequencer"],
  places: {
    melodic: { in: "sequencer", at: ".row[data-track='bass'], .row[data-track='bell']", put: "hide", each: true },
  },
};

export default function () {}
