// Answers the benchmark hook, so the kernel can time a round trip to a worker.

export const manifest = {
  id: "pinger",
  name: "Pinger",
  version: "1.0.0",
  permissions: ["hook:intercept:bench:ping"],
};

export default function (ctx) {
  ctx.on("bench:ping", () => undefined);
}
