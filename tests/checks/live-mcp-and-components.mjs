// Live browser-tab MCP pairing + agent-authored multi-file plugins, custom
// `ui-*` components, and `<ui-dialog>`.
//
// Opens `demos/habits` in an isolated browser context, shares a live MCP link
// from Customize, connects over HTTP as an external MCP client, verifies token
// auth + on-screen connection review, creates a reusable `<ui-streak-pill>`
// component and a multi-file plugin using `<ui-streak-pill>` + `<ui-dialog>`,
// tests Shadow DOM attribute holes, `<slot>`, `data-action` event forwarding
// and hot-reload, and verifies Disconnect invalidates the URL at once.

import { watchErrors } from "../page-errors.mjs";

export default async function ({ check, context, URL: siteUrl, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  watchErrors(page, errors, "live-mcp-and-components");
  const app = "demos/habits";
  await page.goto(`${siteUrl}${app}/app.html`);
  await page.waitForFunction(() => window.__host);

  const command = (name, args) => page.evaluate(([n, a]) => window.__host.command(n, a), [name, { app, ...args }]);
  const review = '[data-key^="review:"]';

  const answerReview = async (what, buttonLabel) => {
    await page.waitForSelector(`${review} >> text=${what}`, { timeout: 15000 });
    await page.click(`${review} button:has-text("${buttonLabel}")`);
    await page.waitForSelector(review, { state: "detached", timeout: 10000 }).catch(() => {});
  };

  const mcpPost = async (url, body, session) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      const dataLines = text
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)));
      json = dataLines.at(-1) ?? null;
    }
    return { status: res.status, session: res.headers.get("mcp-session-id"), json };
  };

  try {
    // 1. Open Customize -> Make a plugin -> Share MCP link for this tab.
    await page.click("ui-panel .launch");
    await page.click('[data-tab="make"]');
    await page.click("[data-live-mcp-open]");
    const liveUrl = await page.locator("[data-live-mcp-url]").inputValue({ timeout: 10000 });
    check("Customize opens a shareable live MCP URL (/mcp/live/<channel>/<token>) for this tab", /^https?:\/\/[^/]+\/mcp\/live\/[0-9a-f]{32}\/[A-Za-z0-9_-]{32}$/.test(liveUrl), liveUrl);

    // 2. Wrong token is refused with 401 before reaching the browser tab.
    const badUrl = liveUrl.replace(/\/[^/]+$/, "/wrongToken1234567890123456789012");
    const unauth = await mcpPost(badUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "Intruder" } } });
    check("a live MCP request with the wrong secret token is refused with 401", unauth.status === 401);

    // 3. Declining the on-screen review card refuses the MCP client.
    const declinedInit = mcpPost(liveUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "Uninvited Bot" } } });
    await answerReview("Uninvited Bot wants to change live MCP access to this tab", "Decline");
    const declinedRes = await declinedInit;
    check("declining the connection review card refuses the MCP session", !declinedRes.session && declinedRes.json?.error?.code === -32001, JSON.stringify(declinedRes));

    // 4. Accepting the review card connects the external MCP client and updates Customize live.
    const initPromise = mcpPost(liveUrl, { jsonrpc: "2.0", id: 2, method: "initialize", params: { clientInfo: { name: "Claude Code" } } });
    await answerReview("Claude Code wants to change live MCP access to this tab", "Accept");
    const initRes = await initPromise;
    const session = initRes.session;
    check("accepting the connection review card issues an Mcp-Session-Id to the external MCP client", initRes.status === 200 && /^[0-9a-f]{32}$/.test(session ?? ""), JSON.stringify(initRes));
    await page.waitForSelector('[data-part="live-mcp"] >> text=Connected right now: Claude Code', { timeout: 10000 });
    check("Customize shows which external MCP client is connected to this tab", true);

    // Close the Customize panel so the page itself is in clear view.
    await page.click("ui-panel .close");

    // 5. List tools and inspect layout via live MCP.
    const listed = await mcpPost(liveUrl, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, session);
    const toolNames = (listed.json?.result?.tools ?? []).map((t) => t.name);
    check(
      "live MCP exposes authoring, custom component, plugin, command and collection tools for this tab",
      ["authoring_layout", "authoring_saveComponent", "authoring_save", "commands_list", "data_list_habits"].every((n) => toolNames.includes(n)),
      toolNames.join(", "),
    );

    const layoutCall = await mcpPost(liveUrl, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "authoring_layout", arguments: {} } }, session);
    const layout = JSON.parse(layoutCall.json?.result?.content?.[0]?.text ?? "{}");
    check("authoring_layout reports the tab's slots and built-in <ui-dialog> element", Array.isArray(layout.slots) && layout.elements?.some((e) => e.tag === "ui-dialog"));

    // 6. Custom component rejects <script> before any review card.
    const badComp = await mcpPost(
      liveUrl,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "authoring_saveComponent", arguments: { tag: "ui-bad-pill", html: "<template><script>alert(1)</script><p>x</p></template>" } },
      },
      session,
    );
    const badCompResult = JSON.parse(badComp.json?.result?.content?.[0]?.text ?? "{}");
    check("a custom ui-* component containing <script> is refused before review", badCompResult.ok === false && /no <script>/i.test(badCompResult.error ?? ""), JSON.stringify(badCompResult));

    // 7. External MCP agent creates a reusable <ui-streak-pill> component.
    const pillHtmlV1 = `<template>
  <style>
    :host { display: inline-flex; }
    .pill { display: inline-flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
  </style>
  <span class="pill" data-version="v1"><strong>{{label}}</strong><span><slot></slot></span><button type="button" data-action="{{action}}">Open details</button></span>
</template>`;
    const saveCompPromise = mcpPost(
      liveUrl,
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "authoring_saveComponent", arguments: { tag: "ui-streak-pill", html: pillHtmlV1 } },
      },
      session,
    );
    await answerReview("ui-streak-pill", "Accept");
    const saveCompRes = JSON.parse((await saveCompPromise).json?.result?.content?.[0]?.text ?? "{}");
    check("external MCP client creates a custom <ui-streak-pill> component after on-screen review", saveCompRes.ok === true && saveCompRes.tag === "ui-streak-pill", JSON.stringify(saveCompRes));

    // 8. External MCP agent saves a multi-file plugin using <ui-streak-pill> and <ui-dialog>.
    const pluginCode = `export const manifest = {
  id: "mcp-streak-banner",
  name: "Streak banner",
  description: "Shows a custom streak pill and a dialog.",
  version: "1.0.0",
  permissions: ["ui"],
  files: ["streak.html"],
  places: { banner: { at: "main", put: "prepend" } },
};
export default function (ctx) {
  const views = ctx.ui.views("streak.html");
  let opened = false;
  const draw = () => views.render("banner", "view", { opened });
  ctx.ui.onEvent((action) => {
    if (action === "open-details") opened = true;
    if (action === "close-details") opened = false;
    draw();
  });
  draw();
}`;
    const pluginHtml = `<template id="view">
  <div class="mcp-banner">
    <ui-streak-pill label="Focus streak" action="open-details">7 days running</ui-streak-pill>
    <ui-dialog open="{{opened}}" label="Streak details" close="close-details">
      <p class="dialog-body">Kept every day this week.</p>
    </ui-dialog>
  </div>
</template>`;
    const savePluginPromise = mcpPost(
      liveUrl,
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "authoring_save", arguments: { code: pluginCode, files: { "streak.html": pluginHtml } } },
      },
      session,
    );
    await answerReview("Streak banner", "Accept");
    const savePluginRes = JSON.parse((await savePluginPromise).json?.result?.content?.[0]?.text ?? "{}");
    check("external MCP client saves a multi-file plugin (code + streak.html) and turns it on", savePluginRes.ok === true && savePluginRes.id === "mcp-streak-banner", JSON.stringify(savePluginRes));

    // 9. Verify <ui-streak-pill> rendered its Shadow DOM, filled {{label}}, projected <slot>, and forwards data-action clicks to open <ui-dialog>.
    await page.waitForSelector("ui-streak-pill", { state: "attached", timeout: 10000 });
    const shadowInfo = await page.evaluate(() => {
      const el = document.querySelector("ui-streak-pill");
      return {
        version: el?.shadowRoot?.querySelector(".pill")?.getAttribute("data-version"),
        label: el?.shadowRoot?.querySelector("strong")?.textContent,
        slotText: el?.textContent?.trim(),
      };
    });
    check(
      "custom <ui-streak-pill> renders Shadow DOM, fills {{label}} attribute holes, and projects <slot>",
      shadowInfo.version === "v1" && shadowInfo.label === "Focus streak" && shadowInfo.slotText === "7 days running",
      JSON.stringify(shadowInfo),
    );

    await page.evaluate(() => document.querySelector("ui-streak-pill")?.shadowRoot?.querySelector("button")?.click());
    await page.waitForFunction(() => document.querySelector("ui-dialog")?.shadowRoot?.querySelector("#dialog")?.matches(":popover-open") === true, null, { timeout: 10000 });
    check("clicking data-action inside a custom ui-* component forwards ui-action to the plugin and opens <ui-dialog>", true);

    await page.evaluate(() => document.querySelector("ui-dialog")?.shadowRoot?.querySelector("button.close")?.click());
    await page.waitForFunction(() => document.querySelector("ui-dialog")?.shadowRoot?.querySelector("#dialog")?.matches(":popover-open") === false, null, { timeout: 10000 });
    check("<ui-dialog> close button emits its close action and closes the dialog", true);

    // 10. Hot-reload <ui-streak-pill> in place via authoring_saveComponent.
    const pillHtmlV2 = pillHtmlV1.replace('data-version="v1"', 'data-version="v2"');
    const reloadCompPromise = mcpPost(
      liveUrl,
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "authoring_saveComponent", arguments: { tag: "ui-streak-pill", html: pillHtmlV2 } },
      },
      session,
    );
    await answerReview("ui-streak-pill", "Accept");
    await reloadCompPromise;
    await page.waitForFunction(() => document.querySelector("ui-streak-pill")?.shadowRoot?.querySelector(".pill")?.getAttribute("data-version") === "v2", null, { timeout: 10000 });
    check("saving an updated custom ui-* component hot-reloads existing instances on the live page", true);

    // 11. Disconnect in Customize invalidates the shared live MCP URL immediately.
    await page.click("ui-panel .launch");
    await page.click('[data-tab="make"]');
    await page.click("[data-live-mcp-close]");
    await page.waitForSelector("[data-live-mcp-open]", { timeout: 10000 });
    const afterClose = await mcpPost(liveUrl, { jsonrpc: "2.0", id: 9, method: "ping" }, session);
    check("disconnecting the tab's live MCP link invalidates the shared URL at once (404)", afterClose.status === 404, JSON.stringify(afterClose));
  } finally {
    await command("user:remove", { id: "mcp-streak-banner" }).catch(() => {});
    await page
      .evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const user = await root.getDirectoryHandle("user-plugins").catch(() => null);
        const habits = await user?.getDirectoryHandle("demos").then((d) => d.getDirectoryHandle("habits")).catch(() => null);
        await habits?.removeEntry("_components", { recursive: true }).catch(() => {});
      })
      .catch(() => {});
    await own.close();
  }
}
