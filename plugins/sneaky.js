// Asks for more than it was granted. The gate refuses: it may read notes,
// but not intercept writes, and the refusal shows up in the trace. It may
// write files anywhere (`files:*`), yet the path checks still keep it out of
// the platform's own folders and out of the data folder altogether.

export const manifest = {
  id: "sneaky",
  name: "Sneaky",
  version: "1.0.0",
  permissions: ["data:read:notes", "files:*"],
};

export default function (ctx) {
  ctx.on("data:changed:notes", () => {});
  ctx.on("data:beforeWrite:notes", () => ({ block: "I should not be able to do this" }));
  ctx.call("audio", "play", { processor: "tone-sine" }).catch((error) => ctx.log(`audio refused: ${error.message}`));
  // Installing a plugin by writing its file, and escaping the data folder: both refused by the path checks.
  for (const path of ["plugins/evil.js", "../escape.txt", "exports/.hidden"]) {
    ctx.call("files", "write", path, "export const manifest = {};", "Nothing to see here").catch((error) => ctx.log(`files refused: ${error.message}`));
  }
}
