// Pay later: tries to replace the pay button with a reminder. The author
// locked the payment section, so the place is refused, and Customize says
// so. The person can still unlock it for this plugin there, after a
// warning: the author's lock is advice the platform enforces, but the
// person has the last word.

export const manifest = {
  id: "pay-later",
  name: "Pay later",
  description: "Swaps the pay button for a reminder to pay on the due date.",
  version: "1.0.0",
  permissions: ["ui"],
  places: {
    pay: { at: "#pay", put: "replace" },
  },
};

export default function (ctx) {
  ctx.ui.render("pay", "reminder", ctx.ui.html`<p class="reminder">Pay on 30 May. You'll find the button here again when you turn this plugin off.</p>`);
}
