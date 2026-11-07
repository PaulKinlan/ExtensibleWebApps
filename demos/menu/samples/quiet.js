// Hide the newsletter box: the smallest plugin that changes a page. A place
// with `put: "hide"` needs no view; the element is hidden while the plugin
// is on, and comes back when it is turned off.

export const manifest = {
  id: "quiet",
  name: "Hide the newsletter box",
  description: "Hides the café's newsletter sign-up.",
  version: "1.0.0",
  permissions: ["ui"],
  places: {
    newsletter: { at: "#newsletter", put: "hide" },
  },
};

export default function () {}
