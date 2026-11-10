import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { expectChatHistoryAttachment } from "../support/helpers/assistant-fork";

async function expectTranscriptTurnActions(page: Page) {
  const menu = page.getByTestId("plugin-turn-actions").getByTestId("assistant-fork-menu-trigger");
  await expect(menu).toHaveCount(1);
  await menu.click();
  await expect(page.getByTestId("assistant-fork-menu-fork-session")).toHaveCount(0);
  await expect(page.getByTestId("assistant-fork-menu-new-tab")).toBeVisible();
  await expect(page.getByTestId("assistant-fork-menu-new-workspace")).toBeVisible();
  await page.keyboard.press("Escape");
}
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  withTimelinePlugin,
  viewInlineThinkingExample,
  requestPluginTimeline,
  interactWithStreamingCard,
  expectWholeCompletedCard,
  expectBothConsecutiveTools,
  trackPluginChatRecovery,
  reconnectPluginChat,
} from "../support/helpers/plugin-timeline";

for (const width of [1100, 390]) {
  test(`assistant plugin receives the whole streaming message at width ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const gate = await installDaemonWebSocketGate(page);
    await withTimelinePlugin(page, info, "assistant", async (agent) => {
      await requestPluginTimeline(agent);
      await interactWithStreamingCard(page);
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await expectWholeCompletedCard(page);
      await expectTranscriptTurnActions(page);
      // Local state is checked during growth; the viewport remounts on the history handoff.
      const recovery = trackPluginChatRecovery(page);
      gate.holdTimelineResponses(agent.agentId);
      await page.reload({ waitUntil: "domcontentloaded" });
      await gate.waitForHeldTimelineResponse();
      await recovery.expectCatalogWithoutRetransmission();
      gate.releaseHeldTimelineResponses();
      await expectWholeCompletedCard(page);
      await recovery.expectRecoveredWithoutRetransmission();
      await expectTranscriptTurnActions(page);
      recovery.reset();
      await reconnectPluginChat(page, gate);
      await recovery.expectRecoveredWithoutRetransmission();
      await expectWholeCompletedCard(page);
      await expectTranscriptTurnActions(page);
      await page
        .getByTestId("plugin-turn-actions")
        .getByTestId("assistant-fork-menu-trigger")
        .click();
      await page.getByTestId("assistant-fork-menu-new-tab").click();
      await expectChatHistoryAttachment(page);
    });
  });
}

test("Overview preserves both consecutive tool plugin cards", async ({ page }, info) => {
  await withTimelinePlugin(page, info, "tools", async (agent) => {
    await requestPluginTimeline(agent);
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await expectBothConsecutiveTools(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectBothConsecutiveTools(page);
  });
});

test("inline-thinking example renders a streamed thought through host UI", async ({
  page,
}, info) => {
  await viewInlineThinkingExample(page, info);
});
