import { expect, type Locator, type TestInfo } from "@playwright/test";
import type { BtwRuntime } from "../../../server/src/server/daemon-e2e/fixtures/pi-btw-stub/runtime";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { closeAgent } from "../support/helpers/rewind-flow";
import { expectComposerEditable, submitMessageWithButton } from "../support/helpers/composer";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import {
  askBtw,
  askBtwFromRunningMainComposer,
  btwBrowserTest,
  captureBtw,
  launchBtwAgent,
  recordedBtwStates,
} from "../support/helpers/pi-btw";

const test = btwBrowserTest(false);
for (const compact of [false, true]) {
  test(`BTW ${compact ? "compact sheet" : "wide docked card"} toggles during generation, retries and restores`, async ({
    page,
    btwRuntime,
  }, info) => {
    test.setTimeout(240000);
    const stub = btwRuntime.stub;
    if (!stub) throw new Error("Missing deterministic HTTP fixture");
    await page.setViewportSize(
      compact ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    );
    const transport = await installDaemonWebSocketGate(page);
    const handle = await launchBtwAgent(page, btwRuntime);
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "btw-browser" });
    const window = page.getByTestId("btw-window").filter({ visible: true });
    const chip = page.getByTestId("btw-chip").filter({ visible: true });
    const hideChip = compact ? page.getByTestId("btw-sheet-chip").filter({ visible: true }) : chip;
    const mainUserCount = async () =>
      (await client.fetchAgentTimeline(handle.agentId, { limit: 0 })).entries.filter(
        ({ item }) => item.type === "user_message",
      ).length;
    try {
      await submitMessageWithButton(page, "PARENT_A");
      await expect(
        page.getByTestId("assistant-message").filter({ hasText: "PARENT_A_FINISHED" }),
      ).toBeVisible({ timeout: 60000 });
      await handle.client.waitForFinish(handle.agentId, 60000);
      await submitMessageWithButton(page, "HOLD_PARENT");
      await expect.poll(() => stub.pending("parent")).toBe(1);
      await askBtwFromRunningMainComposer(page, "HOLD_BTW");
      await expect(window).toBeVisible();
      await expect.poll(() => stub.pending("btw")).toBe(1);
      await expect(window.getByTestId("btw-inject")).toBeDisabled();
      await expect(window.getByTestId("btw-summarize")).toBeDisabled();
      const threadId = await window.getAttribute("aria-label");
      const initialMainUsers = await mainUserCount();
      await expect(page.getByTestId("subagents-track-header")).toHaveCount(0);
      await waitForSettledPosition(window);
      await captureBtw(page, info, `btw-${compact ? "compact" : "wide"}-running`);
      if (!compact) {
        const card = await page.getByTestId("btw-floating-card").boundingBox();
        expect(card?.width).toBe(440);
        expect(card?.height).toBeLessThanOrEqual(540);
      }
      await hideChip.click();
      await expect(window).toBeHidden();
      await expect.poll(() => stub.pending("btw")).toBe(1);
      await chip.click();
      await expect(window).toHaveAttribute("aria-label", threadId ?? "");
      await hideChip.click();
      stub.release("btw");
      await expect
        .poll(async () => (await client.listProviderSubagents(handle.agentId)).subagents[0]?.status)
        .toBe("completed");
      await expect(window).toBeHidden();
      await captureBtw(page, info, "btw-minimized");
      await chip.click();
      await expect(window).toContainText("BTW_REPLY CONTEXT_A");
      await expect(window.getByTestId("btw-subtitle")).toContainText("pinned turn 1");
      expect((await client.fetchAgentTimeline(handle.agentId, { limit: 0 })).agent?.status).toBe(
        "running",
      );
      stub.release("parent");
      await handle.client.waitForFinish(handle.agentId, 60000);
      await askBtw(page, "AFTER_B");
      await expect(window).toContainText("BTW_REPLY AFTER_B");
      await expect(window.getByTestId("btw-subtitle")).toContainText("pinned turn 2");
      await askBtw(page, "HOLD_BTW");
      await expect.poll(() => stub.pending("btw")).toBe(1);
      await window.getByTestId("btw-stop").click();
      await expect
        .poll(async () => (await client.listProviderSubagents(handle.agentId)).subagents[0]?.status)
        .toBe("canceled");
      await askBtw(page, "FAIL_BTW");
      await expect(window.getByTestId("btw-provider-error")).toBeVisible({ timeout: 60000 });
      await captureBtw(page, info, "btw-provider-failed");
      await askBtw(page, "AFTER_B retry");
      await expect
        .poll(async () => (await client.listProviderSubagents(handle.agentId)).subagents[0]?.status)
        .toBe("completed");
      await expect(window.getByTestId("btw-provider-error")).toHaveCount(0);
      await expect(window.getByTestId("btw-composer")).toHaveValue("");
      const requestCount = stub.requests.length;
      const listRequests = transport.getClientRequestCount("agent.provider_subagents.list.request");
      await transport.drop();
      await transport.waitForBlockedConnection();
      await askBtw(page, "AFTER_B dispatch retry");
      await expect(window.getByTestId("btw-action-feedback")).toContainText(
        /connect|socket|offline/i,
      );
      await expect(window.getByTestId("btw-composer")).toHaveValue("AFTER_B dispatch retry");
      transport.restore();
      await transport.waitForServerMessage(
        "agent.provider_subagents.list.response",
        listRequests + 1,
      );
      expect(stub.requests).toHaveLength(requestCount);
      await window.getByTestId("btw-send").click();
      await expect(window.getByTestId("btw-composer")).toHaveValue("");
      await expect
        .poll(async () => (await client.listProviderSubagents(handle.agentId)).subagents[0]?.status)
        .toBe("completed");
      // Only explicit delivery adds a main user message; window sends and hides add none.
      expect(await mainUserCount()).toBe(initialMainUsers);
      await verifyBusyMainDeliveries({ client, handle, stub, window, mainUserCount, info });
      const before = await client.fetchProviderSubagentTimeline(handle.agentId, threadId ?? "", {
        limit: 0,
      });
      await client.refreshAgent(handle.agentId);
      await expect(window).toHaveAttribute("aria-label", threadId ?? "");
      expect(
        (
          await client.fetchProviderSubagentTimeline(handle.agentId, threadId ?? "", { limit: 0 })
        ).rows.map(({ item }) => item),
      ).toEqual(before.rows.map(({ item }) => item));
      // Refresh replaces the keyed owner; its previous sheet finishes dismissing before interaction.
      await expect(window).toHaveCount(1);
      await waitForSettledPosition(window);
      await expect(window.getByTestId("btw-minimize")).toHaveCount(1);
      await window.getByTestId("btw-minimize").click();
      await expect(window).toBeHidden();
      await page.reload();
      await expect(window).toHaveAttribute("aria-label", threadId ?? "");
      // Restart only this fixture daemon. The supervisor remains owned by the existing harness.
      const previousPid = (await client.getDaemonStatus()).pid;
      await client.restartServer("BTW isolated restart");
      await expect
        .poll(
          async () => {
            try {
              return (await client.getDaemonStatus()).pid;
            } catch {
              return previousPid;
            }
          },
          { timeout: 60000 },
        )
        .not.toBe(previousPid);
      await page.reload();
      await expect(chip).toBeVisible({ timeout: 60000 });
      await expect(window).toBeVisible();
      const after = await client.fetchProviderSubagentTimeline(handle.agentId, threadId ?? "", {
        limit: 0,
      });
      expect(after.rows.map(({ item }) => item)).toEqual(before.rows.map(({ item }) => item));
      await waitForSettledPosition(window);
      await captureBtw(page, info, "btw-restored-after-restart");
      await window.getByTestId("btw-new").click();
      await expect
        .poll(async () => {
          const ids = await window.evaluateAll((elements) => {
            const labels: Array<string | null> = [];
            for (const element of elements) labels.push(element.getAttribute("aria-label"));
            return labels;
          });
          return { count: ids.length, replacement: ids.length === 1 && ids[0] !== threadId };
        })
        .toEqual({ count: 1, replacement: true });
      await waitForSettledPosition(window);
      await expect(window).not.toHaveAttribute("aria-label", threadId ?? "");
      await expect(window.getByTestId("btw-inject")).toBeDisabled();
      await expect(window.getByTestId("btw-summarize")).toBeDisabled();
      await window.getByTestId("btw-clear").click();
      await expect(window).toBeHidden();
      await expect(chip).toHaveCount(0);
      await info.attach("btw-boundaries", {
        body: JSON.stringify(
          { revision: btwRuntime.revision, states: await recordedBtwStates(btwRuntime) },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      transport.restore();
      stub.release("parent");
      stub.release("btw");
      await client.close();
      await closeAgent(handle);
    }
  });
}

test("BTW compact sheet backdrop dismissal preserves generation and reopens the same thread", async ({
  page,
  btwRuntime,
}, info) => {
  test.setTimeout(120000);
  const stub = btwRuntime.stub;
  if (!stub) throw new Error("Missing deterministic HTTP fixture");
  await page.setViewportSize({ width: 390, height: 844 });
  const handle = await launchBtwAgent(page, btwRuntime);
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "btw-dismissal" });
  const window = page.getByTestId("btw-window").filter({ visible: true });
  const chip = page.getByTestId("btw-chip").filter({ visible: true });
  const backdrop = page.getByRole("button", { name: "Bottom sheet backdrop", exact: true });
  try {
    await submitMessageWithButton(page, "PARENT_A");
    await handle.client.waitForFinish(handle.agentId, 60000);
    await submitMessageWithButton(page, "HOLD_PARENT");
    await expect.poll(() => stub.pending("parent")).toBe(1);
    await askBtwFromRunningMainComposer(page, "HOLD_BTW");
    await expect(window).toBeVisible();
    await expect.poll(() => stub.pending("btw")).toBe(1);
    await waitForSettledPosition(window);
    const threadId = await window.getAttribute("aria-label");
    const beforeThread = (await recordedBtwStates(btwRuntime)).at(-1);
    expect(beforeThread).toMatchObject({ status: "running" });
    expect(threadId).toBe(`btw:${beforeThread?.threadId}`);
    const beforeMain = await client.fetchAgentTimeline(handle.agentId, { limit: 0 });
    const beforeRows = await client.fetchProviderSubagentTimeline(handle.agentId, threadId ?? "", {
      limit: 0,
    });
    const beforeRequests = stub.requests.length;
    await expect(backdrop).toHaveCount(1);
    // The real modal backdrop dismisses the sheet through its provider and onDismiss handler.
    await backdrop.click({ position: { x: 12, y: 12 } });
    await expect(backdrop).toHaveCount(0);
    await expect(window).toBeHidden();
    await expect(chip).toBeVisible();
    expect(stub.pending("btw")).toBe(1);
    expect(stub.pending("parent")).toBe(1);
    expect(stub.requests).toHaveLength(beforeRequests);
    expect((await recordedBtwStates(btwRuntime)).at(-1)).toEqual(beforeThread);
    expect(
      (await client.fetchAgentTimeline(handle.agentId, { limit: 0 })).entries.map(
        ({ item }) => item,
      ),
    ).toEqual(beforeMain.entries.map(({ item }) => item));
    await captureBtw(page, info, "btw-compact-backdrop-dismissed-running");
    await chip.click();
    await expect(window).toHaveAttribute("aria-label", threadId ?? "");
    await expect(window.getByTestId("btw-stop")).toBeVisible();
    expect(
      (
        await client.fetchProviderSubagentTimeline(handle.agentId, threadId ?? "", { limit: 0 })
      ).rows.map(({ item }) => item),
    ).toEqual(beforeRows.rows.map(({ item }) => item));
    await waitForSettledPosition(window);
    await captureBtw(page, info, "btw-compact-backdrop-reopened-running");
    stub.release("btw");
    await expect(window).toContainText("BTW_REPLY CONTEXT_A");
    await expect
      .poll(async () => (await client.listProviderSubagents(handle.agentId)).subagents[0]?.status)
      .toBe("completed");
    expect(stub.pending("parent")).toBe(1);
    expect(stub.requests).toHaveLength(beforeRequests);
    expect((await client.fetchAgentTimeline(handle.agentId, { limit: 0 })).agent?.status).toBe(
      "running",
    );
    await info.attach("backdrop-dismissal-proof", {
      body: JSON.stringify(
        {
          threadId,
          beforeThread,
          afterThread: (await recordedBtwStates(btwRuntime)).at(-1),
          beforeRequests,
          requestsAfter: stub.requests.length,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    stub.release("parent");
    await handle.client.waitForFinish(handle.agentId, 60000);
  } finally {
    stub.release("parent");
    stub.release("btw");
    await client.close();
    await closeAgent(handle);
  }
});

const withoutExtensionTest = btwBrowserTest(false, false);
for (const compact of [false, true]) {
  withoutExtensionTest(
    `BTW absent extension ${compact ? "compact" : "wide"} keeps the main fallback without a window or pill`,
    async ({ page, btwRuntime }, info) => {
      withoutExtensionTest.setTimeout(120000);
      const stub = btwRuntime.stub;
      if (!stub) throw new Error("Missing deterministic HTTP fixture");
      await page.setViewportSize(
        compact ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      );
      const handle = await launchBtwAgent(page, btwRuntime);
      const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "btw-absent" });
      try {
        await expect(page.getByTestId("btw-window")).toHaveCount(0);
        await expect(page.getByTestId("btw-chip")).toHaveCount(0);
        const beforeRequests = stub.requests.length;
        await submitMessageWithButton(page, "/btw no extension");
        await expect.poll(() => stub.requests.length).toBe(beforeRequests + 1);
        await expect(
          page.getByTestId("assistant-message").filter({ hasText: "PARENT_A_FINISHED" }),
        ).toBeVisible({ timeout: 60000 });
        await handle.client.waitForFinish(handle.agentId, 60000);
        const fallback = stub.requests.at(-1);
        expect(fallback?.messages.at(-1)).toMatchObject({
          role: "user",
          content: [{ type: "text", text: "/btw no extension" }],
        });
        expect(JSON.stringify(fallback?.messages)).not.toContain("<btw>");
        expect((await client.listProviderSubagents(handle.agentId)).subagents).toEqual([]);
        const timeline = await client.fetchAgentTimeline(handle.agentId, { limit: 0 });
        expect(timeline.agent?.status).toBe("idle");
        expect(
          timeline.entries
            .filter(({ item }) => item.type === "user_message")
            .map(({ item }) => item),
        ).toEqual([expect.objectContaining({ type: "user_message", text: "/btw no extension" })]);
        await expectComposerEditable(page);
        await expect(page.getByTestId("btw-window")).toHaveCount(0);
        await expect(page.getByTestId("btw-chip")).toHaveCount(0);
        await captureBtw(page, info, `btw-absent-${compact ? "compact" : "wide"}-main-fallback`);
        await info.attach("absent-extension-fallback", {
          body: JSON.stringify(
            { revision: btwRuntime.revision, fallback, mainTimeline: timeline },
            null,
            2,
          ),
          contentType: "application/json",
        });
      } finally {
        await client.close();
        await closeAgent(handle);
      }
    },
  );
}

interface BtwBusyDeliveryInput {
  client: DaemonClient;
  handle: Awaited<ReturnType<typeof launchBtwAgent>>;
  stub: NonNullable<BtwRuntime["stub"]>;
  window: Locator;
  mainUserCount(): Promise<number>;
  info: TestInfo;
}
async function verifyBusyMainDeliveries({
  client,
  handle,
  stub,
  window,
  mainUserCount,
  info,
}: BtwBusyDeliveryInput) {
  for (const action of ["btw-inject", "btw-summarize"]) {
    // Pi publishes this held parent's user row only when its response begins.
    const beforeHeldParentUsers = await mainUserCount();
    await client.sendAgentMessage(handle.agentId, "HOLD_PARENT", { messageId: "" });
    await expect.poll(() => stub.pending("parent")).toBe(1);
    const beforeThread = (await client.listProviderSubagents(handle.agentId)).subagents[0];
    const beforeRequests = stub.requests.length;
    const mainRequests = () =>
      stub.requests.filter((request) => !JSON.stringify(request.messages).includes("<btw>"));
    const beforeMainRequests = mainRequests().length;
    await expect(window.getByTestId(action)).toBeEnabled();
    await window.getByTestId(action).click();
    await expect(window.getByTestId("btw-action-feedback")).toContainText("Command accepted");
    if (action === "btw-summarize") {
      await expect.poll(() => stub.requests.length).toBe(beforeRequests + 1);
      await expect
        .poll(async () => {
          const thread = (await client.listProviderSubagents(handle.agentId)).subagents[0];
          return { status: thread?.status, advanced: thread?.updatedAt !== beforeThread.updatedAt };
        })
        .toEqual({ status: "completed", advanced: true });
    }
    expect(stub.pending("parent")).toBe(1);
    expect(mainRequests()).toHaveLength(beforeMainRequests);
    expect((await client.fetchAgentTimeline(handle.agentId, { limit: 0 })).agent?.status).toBe(
      "running",
    );
    stub.release("parent");
    await expect.poll(mainUserCount, { timeout: 60000 }).toBe(beforeHeldParentUsers + 2);
    await handle.client.waitForFinish(handle.agentId, 60000);
    expect(stub.pending("parent")).toBe(0);
    expect(mainRequests()).toHaveLength(beforeMainRequests + 1);
    expect(await mainUserCount()).toBe(beforeHeldParentUsers + 2);
    const users = (await client.fetchAgentTimeline(handle.agentId, { limit: 0 })).entries.filter(
      ({ item }) => item.type === "user_message",
    );
    expect(users.at(-2)?.item).toMatchObject({ type: "user_message", text: "HOLD_PARENT" });
    expect(users.at(-1)?.item).toMatchObject({
      type: "user_message",
      text: expect.stringContaining("BTW_REPLY"),
    });
    const delivered = mainRequests().at(-1)?.messages;
    expect(delivered?.at(-2)).toMatchObject({
      role: "assistant",
      content: "PARENT_B_FINISHED",
    });
    expect(delivered?.at(-1)?.role).toBe("user");
    expect(JSON.stringify(delivered?.at(-1)?.content)).toContain("BTW_REPLY");
    await info.attach(`busy-${action}`, {
      body: JSON.stringify(
        {
          action,
          beforeHeldParentUsers,
          usersAfter: users.length,
          beforeMainRequests,
          mainRequestsAfter: mainRequests().length,
          delivered,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  }
}
