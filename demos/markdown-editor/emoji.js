// Emoji: a picker that puts an emoji in at the cursor, your recent ones
// first. "Insert emoji…" (Mod+Shift+E) opens it in the panels.

export const manifest = {
  id: "emoji",
  name: "Emoji",
  description: "Insert an emoji from a picker (Mod+Shift+E), with your recent ones first.",
  version: "2.0.0",
  order: 150,
  permissions: ["ui", "document:write", "hook:listen:posts:close"],
  services: ["document"],
};

const EMOJI = `😀 grinning|😂 tears of joy|🙂 smile|😉 wink|😍 heart eyes|🤔 thinking|😅 sweat smile|😬 grimace|😢 cry|😮 surprised|🙄 eye roll|😎 cool|🥳 party|🤯 mind blown|🙏 thanks|👍 thumbs up|👎 thumbs down|👏 clap|🙌 hooray|👀 eyes|💪 strong|🤝 handshake|👋 wave|✌️ peace|❤️ heart|💔 broken heart|🔥 fire|✨ sparkles|⭐ star|🎉 tada|🎯 target|💡 idea|📌 pin|📎 paperclip|📝 memo|📚 books|📖 book|📈 chart up|📉 chart down|📊 bar chart|🗓️ calendar|⏰ alarm|⏳ hourglass|✅ check|❌ cross|⚠️ warning|❓ question|❗ exclamation|➡️ right arrow|⬅️ left arrow|⬆️ up arrow|⬇️ down arrow|🔗 link|🔒 lock|🔑 key|🛠️ tools|⚙️ gear|🐛 bug|🚀 rocket|💻 laptop|📱 phone|🖥️ desktop|⌨️ keyboard|🖱️ mouse|🌐 web|🤖 robot|🧠 brain|🧪 test tube|🔬 microscope|📦 package|🗑️ bin|☕ coffee|🍕 pizza|🎵 music|📷 camera|🎥 film|🌟 glowing star|🌈 rainbow|☀️ sun|🌧️ rain|❄️ snow|🌍 globe|🏆 trophy|🥇 gold medal|💯 hundred|➕ plus|➖ minus`.split("|");

export default async function (ctx) {
  let recent = (await ctx.storage.get("recent")) ?? [];
  let open = false;
  /** The picker's emoji, recent first, each { i, emoji, name }. */
  let items = [];

  const draw = () => {
    if (!open) return ctx.ui.render("panels", "emoji", null);
    const order = [...recent.filter((r) => EMOJI.includes(r)), ...EMOJI.filter((e) => !recent.includes(e))].slice(0, 100);
    items = order.map((entry, i) => ({ i, emoji: entry.split(" ")[0], name: entry.slice(entry.indexOf(" ") + 1), entry }));
    ctx.ui.views("emoji.html").render("panels", "emoji", { items });
  };

  ctx.commands.add({ id: "insert", title: "Insert emoji…", keys: ["Mod+Shift+E"] }, () => {
    open = true;
    draw();
  });
  ctx.ui.render("toolbar", "button", { type: "button", label: "Emoji", action: "toggle" });
  ctx.ui.onEvent(async (action) => {
    if (action === "toggle") open = !open;
    if (action === "close") open = false;
    const pick = action.startsWith("pick:") && items[Number(action.slice(5))];
    if (pick) {
      await ctx.call("document", "insert", pick.emoji);
      recent = [pick.entry, ...recent.filter((r) => r !== pick.entry)].slice(0, 8);
      await ctx.storage.set("recent", recent);
      open = false;
    }
    draw();
  });
  ctx.on("posts:close", () => {
    open = false;
    draw();
  });
}
