// Timer: fills a slot another plugin declared. The cookbook's open recipe
// has <slot name="cookbook.recipe.actions" data-minutes="…">, a room it
// leaves for plugins like this one. Rendering to that name draws in every
// such slot; page.slots says what each one is for (its data-* attributes),
// so this plugin draws a button for the recipe's own time in each.
//
// The cookbook doesn't know this plugin exists, and this plugin can't touch
// the cookbook's view: only the room it was given. When the slots change (a
// recipe opens or closes), the event "slot:changed" says to look again.

export const manifest = {
  id: "timer",
  name: "Kitchen timer",
  description: "A timer for the open recipe, in the room the cookbook leaves for it.",
  version: "1.0.0",
  permissions: ["ui"],
  order: 30,
};

const SLOT = "cookbook.recipe.actions";

export default async function (ctx) {
  const html = ctx.ui.html;
  let timer = null; // { title, ends }
  let tick = null;

  /** A button in each recipe's slot, for that recipe's time. */
  const fill = async () => {
    const slots = await ctx.call("page", "slots", SLOT);
    slots.forEach(({ data }, i) => {
      const minutes = Number(data.minutes);
      ctx.ui.render(
        `${SLOT}#${i}`,
        "timer",
        minutes > 0 ? html`<button data-action="start" data-value="${JSON.stringify({ title: data.title, minutes })}">Start a ${minutes} minute timer</button>` : null,
      );
    });
  };

  /** The countdown, in the side column, while a timer runs; a hint while none does. */
  const show = () => {
    if (!timer) return ctx.ui.render("side", "countdown", html`<p><small>Open a recipe to start a timer for it.</small></p>`);
    const left = Math.max(0, Math.round((timer.ends - Date.now()) / 1000));
    const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    ctx.ui.render(
      "side",
      "countdown",
      html`<ui-card tone="${left ? "accent" : "ok"}">
        <h3>${timer.title}</h3>
        <ui-stat label="${left ? "Time left" : "Done"}" value="${clock}"></ui-stat>
        <button data-action="stop">${left ? "Stop" : "Dismiss"}</button>
      </ui-card>`,
    );
    if (!left) clearInterval(tick);
  };

  ctx.ui.onEvent((action, value) => {
    if (action === "slot:changed") return void fill();
    if (action === "start") {
      const { title, minutes } = JSON.parse(value);
      timer = { title, ends: Date.now() + minutes * 60_000 };
      clearInterval(tick);
      tick = setInterval(show, 1000);
    }
    if (action === "stop") {
      timer = null;
      clearInterval(tick);
    }
    show();
  });
  show();
  await fill();
}
