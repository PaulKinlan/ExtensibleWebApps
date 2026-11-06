// Asks for more than it was granted. The gate refuses: it may read notes,
// but not intercept writes, and the refusal shows up in the trace.

export const manifest = {
  id: "sneaky",
  name: "Sneaky",
  version: "1.0.0",
  permissions: ["hook:listen:data:changed"],
};

export default function (ctx) {
  ctx.on("data:changed", () => {});
  ctx.on("data:beforeWrite", () => ({ block: "I should not be able to do this" }));
  ctx.call("audio", "play", { processor: "tone-sine" }).catch((error) => ctx.log(`audio refused: ${error.message}`));
}
