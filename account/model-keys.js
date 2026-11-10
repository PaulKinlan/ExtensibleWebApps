// Your model keys: whether the API keys you give for models (Gemini, Claude,
// OpenAI…) follow you to your other devices. They can, encrypted on this
// device with a passphrase or a passkey only you hold, so this site's server
// keeps them and can never read one (std/follow/vault.ts). A new device asks
// for that passphrase or passkey once, here, instead of for each key. The
// passphrase is typed into a card the kernel draws, so this plugin never
// sees it. Shown only to someone signed in.

export const manifest = {
  id: "account-model-keys",
  name: "Your model keys",
  description: "Have the API keys you give for models follow you to your other devices, encrypted so this site can't read them.",
  version: "1.0.0",
  scope: "tab",
  permissions: ["ui", "account", "hook:listen:account:changed"],
  services: ["account"],
};

export default async function (ctx) {
  const views = ctx.ui.views("model-keys.html");
  let status = "";
  let failed = false;
  /** Whether "take them out of my account" is waiting for a second click. */
  let confirming = false;

  const draw = async () => {
    const keys = await ctx.call("account", "keys").catch((error) => ({ state: "error", error: error.message }));
    views.render("model-keys", "model-keys", {
      shown: keys.state !== "signed-out",
      off: keys.state === "off",
      locked: keys.state === "locked",
      on: keys.state === "on",
      passphrase: !!keys.passphrase,
      passkey: !!keys.passkey,
      addPassphrase: keys.state === "on" && !keys.passphrase,
      addPasskey: keys.state === "on" && !keys.passkey,
      confirming,
      canRemove: !confirming && (keys.state === "on" || keys.state === "locked"),
      removeLabel: keys.state === "locked" ? "Lost it? Start again without these keys" : "Take my keys out of my account",
      status: keys.state === "error" ? keys.error : status,
      failed: failed || keys.state === "error",
      said: !failed && keys.state !== "error" && !!status,
    });
  };

  const run = async (method, how, done) => {
    status = "";
    failed = false;
    confirming = false;
    try {
      const before = await ctx.call("account", "keys");
      const after = await ctx.call("account", method, how);
      // Unchanged means the person closed the card: nothing to say.
      status = JSON.stringify(before) === JSON.stringify(after) && method !== "keys:remove" ? "" : done;
    } catch (error) {
      status = error.message;
      failed = true;
    }
    await draw();
  };

  ctx.on("account:changed", () => draw());
  ctx.ui.onEvent((action) => {
    if (action === "protect-passphrase") return run("keys:protect", {}, "Done. Your keys now follow you: on another device, sign in and unlock them here with that passphrase.");
    if (action === "protect-passkey") return run("keys:protect", { passkey: true }, "Done. Your keys now follow you: on another device, sign in and unlock them here with that passkey.");
    if (action === "unlock-passphrase") return run("keys:unlock", {}, "Unlocked. Your keys are on this device from now on.");
    if (action === "unlock-passkey") return run("keys:unlock", { passkey: true }, "Unlocked. Your keys are on this device from now on.");
    if (action === "remove") {
      confirming = true;
      status = "";
      return draw();
    }
    if (action === "cancel") {
      confirming = false;
      return draw();
    }
    if (action === "remove-yes") return run("keys:remove", undefined, "Your keys are out of your account. Each device keeps the keys it already has.");
  });
  await draw();
}
