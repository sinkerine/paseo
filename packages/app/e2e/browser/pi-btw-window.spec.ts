import { toggleSettingsWithShortcut, selectSendingOption } from "../support/helpers/settings";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { BtwRuntime } from "../../../server/src/server/daemon-e2e/fixtures/pi-btw-stub/runtime";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { closeAgent } from "../support/helpers/rewind-flow";
import {
  expectComposerEditable,
  fillComposerDraft,
  submitMessageWithButton,
} from "../support/helpers/composer";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import {
  askBtw,
  btwRequests,
  pressBtwComposerKey,
  btwViewportGeometry,
  expectBtwTextInViewport,
  revealBtwText,
  askBtwFromRunningMainComposer,
  btwBrowserTest,
  captureBtw,
  launchBtwAgent,
  recordedBtwStates,
  closeBtwSurface,
  btwScrollFrames,
  waitForBtwViewportSettled,
  expectBtwViewportHeld,
} from "../support/helpers/pi-btw";

function parentChatContainer(page: Page, compact: boolean): Locator {
  const input = page.getByTestId("message-input-root");
  return compact
    ? input
        .filter({ visible: true })
        .locator('xpath=ancestor::*[.//*[@data-testid="agent-chat-scroll"]][1]')
    : page.locator('[data-testid^="workspace-pane-"]:visible').filter({ has: input });
}

async function reopenBtwViewport(input: {
  page: Page;
  compact: boolean;
  agentId: string;
  threadId: string;
  transport: Awaited<ReturnType<typeof installDaemonWebSocketGate>>;
}) {
  const { page, compact, agentId, threadId, transport } = input;
  const reads = transport.getClientRequestCount("agent.provider_subagents.timeline.get.request");
  await closeBtwSurface(page, agentId, compact);
  await page.getByTestId("btw-chip").filter({ visible: true }).click();
  const panel = page.getByTestId("btw-panel").filter({ visible: true });
  await expect(panel).toHaveAttribute("aria-label", threadId);
  await transport.waitForServerMessage("agent.provider_subagents.timeline.get.response", reads + 1);
  await waitForSettledPosition(panel);
  const scroller = panel.getByTestId("agent-chat-scroll");
  await waitForBtwViewportSettled(scroller);
  const entryFrames = await btwScrollFrames(scroller, 30);
  const baseline = entryFrames[0];
  if (!baseline) throw new Error("Missing settled reopened viewport");
  expectBtwViewportHeld(baseline, entryFrames);
  return { baseline, entryFrames };
}

interface MainEntryContext {
  page: Page;
  client: DaemonClient;
  agentId: string;
  compact: boolean;
  running: boolean;
  stub: NonNullable<BtwRuntime["stub"]>;
}
async function mainUserTexts(client: DaemonClient, agentId: string) {
  return (await client.fetchAgentTimeline(agentId, { limit: 0 })).entries.flatMap(({ item }) =>
    item.type === "user_message" ? [item.text] : [],
  );
}
async function exerciseMainEntry(
  context: MainEntryContext,
  entry: {
    command: string;
    question: string | null;
    previousId: string | null;
  },
) {
  const { page, client, agentId, compact, running, stub } = context;
  const panel = page.getByTestId("btw-panel").filter({ visible: true });
  if ((await panel.count()) > 0) await closeBtwSurface(page, agentId, compact);
  const beforeThread = (await client.listProviderSubagents(agentId)).subagents.find(
    (row) => row.presentation === "side_conversation",
  );
  if (entry.command === "/btw:new") expect(beforeThread?.id).toBe(entry.previousId);
  else expect(beforeThread).toBeUndefined();
  const beforeUsers = await mainUserTexts(client, agentId);
  const beforeParent = (await client.fetchAgentTimeline(agentId, { limit: 0 })).agent?.status;
  const beforeRequests = stub.requests.length;
  const mainRequests = () =>
    stub.requests.filter((request) => !JSON.stringify(request.messages).includes("<btw>"));
  const beforeMainRequests = mainRequests().length;
  const command = `${entry.command}${entry.question ? ` ${entry.question}` : ""}`;
  await fillComposerDraft(page, command);
  await page
    .getByRole("button", { name: running ? "Send and steer" : "Send message", exact: true })
    .click();
  const thread = async () =>
    (await client.listProviderSubagents(agentId)).subagents.find(
      (row) => row.presentation === "side_conversation",
    );
  await expect
    .poll(async () => {
      const id = (await thread())?.id;
      return id && id !== entry.previousId ? id : "";
    })
    .toMatch(/^btw:/);
  const descriptor = await thread();
  if (!descriptor) throw new Error("Main composer entry did not create a BTW descriptor");
  if (entry.question) {
    await expect.poll(() => stub.requests.length).toBe(beforeRequests + 1);
    await expect
      .poll(async () =>
        (
          await client.fetchProviderSubagentTimeline(agentId, descriptor.id, {
            direction: "tail",
            limit: 200,
          })
        ).rows
          .flatMap(({ item }) => (item.type === "user_message" ? [item.text] : []))
          .at(-1),
      )
      .toBe(entry.question);
    await expect.poll(async () => (await thread())?.status).toBe("completed");
  } else {
    expect(stub.requests).toHaveLength(beforeRequests);
  }
  const history = await client.fetchProviderSubagentTimeline(agentId, descriptor.id, {
    direction: "tail",
    limit: 200,
  });
  expect(history.error).toBeNull();
  if (!entry.question)
    expect(
      history.rows.filter(
        ({ item }) => item.type === "user_message" || item.type === "assistant_message",
      ),
    ).toEqual([]);
  const main = page.getByRole("textbox", { name: "Message agent..." });
  await expect(main).toBeFocused();
  await page.keyboard.type("entry-focus");
  await expect(main).toHaveValue("entry-focus");
  await main.fill("");
  await expect(panel).toHaveAttribute("aria-label", descriptor.id);
  if (compact) {
    await expect(page.getByTestId("sheet-tab-header")).toContainText("BTW");
    await expect(page.getByTestId("sheet-tab-body").getByTestId("btw-panel")).toBeVisible();
    await expect(page.getByTestId("sheet-tab-open-as-tab")).toHaveCount(0);
  } else {
    const parent = parentChatContainer(page, false);
    const side = page.locator('[data-testid^="workspace-pane-"]:visible').filter({ has: panel });
    await expect(side).toHaveCount(1);
    await expect(page.getByTestId(`workspace-tab-btw_${agentId}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const left = await parent.boundingBox();
    const right = await side.boundingBox();
    if (!left || !right) throw new Error("Missing alias placement geometry");
    expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
    await expect(main).toBeFocused();
  }
  await expect(panel.getByTestId("btw-composer")).toHaveValue("");
  if (entry.question) await expect(panel.getByText(entry.question, { exact: true })).toBeVisible();
  else {
    await expect(panel.getByTestId("btw-inject")).toBeDisabled();
    await expect(panel.getByTestId("btw-summarize")).toBeDisabled();
  }
  const afterUsers = await mainUserTexts(client, agentId);
  expect(afterUsers).toEqual([...beforeUsers, command]);
  expect((await client.fetchAgentTimeline(agentId, { limit: 0 })).agent?.status).toBe(beforeParent);
  expect(mainRequests()).toHaveLength(beforeMainRequests);
  expect(stub.pending("parent")).toBe(running ? 1 : 0);
  return {
    command,
    parentState: running ? "running" : "idle",
    threadId: descriptor.id,
    previousId: entry.previousId,
    beforeThreadId: beforeThread?.id ?? null,
    fresh: true,
    beforeUsers,
    afterUsers,
    history,
    beforeRequests,
    afterRequests: stub.requests.length,
  };
}

const test = btwBrowserTest(false);
for (const compact of [false, true]) {
  test(`BTW ${compact ? "compact" : "wide"} main composer aliases and empty entry preserve routing`, async ({
    page,
    btwRuntime,
  }, info) => {
    test.setTimeout(240000);
    const stub = btwRuntime.stub;
    if (!stub) throw new Error("Missing deterministic HTTP fixture");
    await page.setViewportSize(
      compact ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    );
    const handle = await launchBtwAgent(page, btwRuntime);
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "btw-entry-matrix" });
    const proof = [];
    const entries = [
      { command: "/btw", question: null },
      { command: "/btw", question: "ENTRY_BTW" },
      { command: "/side", question: "ENTRY_SIDE" },
      { command: "/btw:new", question: "ENTRY_NEW" },
    ] as const;
    try {
      await submitMessageWithButton(page, "PARENT_A");
      await handle.client.waitForFinish(handle.agentId, 60000);
      for (const running of [false, true]) {
        if (running) {
          const panel = page.getByTestId("btw-panel").filter({ visible: true });
          await panel.getByTestId("btw-clear").click();
          await expect(panel.getByTestId("btw-empty")).toBeVisible();
          await expect(panel.getByTestId("btw-composer")).toBeEditable();
          await closeBtwSurface(page, handle.agentId, compact);
          await submitMessageWithButton(page, "HOLD_PARENT");
          await expect.poll(() => stub.pending("parent")).toBe(1);
        }
        let previousId: string | null = null;
        for (const entry of entries) {
          if (previousId && entry.command !== "/btw:new") {
            const panel = page.getByTestId("btw-panel").filter({ visible: true });
            await panel.getByTestId("btw-clear").click();
            await expect(panel.getByTestId("btw-empty")).toBeVisible();
            await expect
              .poll(async () => (await client.listProviderSubagents(handle.agentId)).subagents)
              .toEqual([]);
          }
          const result = await exerciseMainEntry(
            { page, client, agentId: handle.agentId, compact, running, stub },
            {
              ...entry,
              previousId,
              question: entry.question ? `${entry.question}_${running ? "RUNNING" : "IDLE"}` : null,
            },
          );
          previousId = result.threadId;
          proof.push(result);
        }
      }
      await captureBtw(page, info, `btw-${compact ? "compact" : "wide"}-main-entry-matrix`);
    } finally {
      await info.attach("btw-main-entry-matrix", {
        body: JSON.stringify(proof),
        contentType: "application/json",
      });
      stub.release("parent");
      stub.release("btw");
      await client.close();
      await closeAgent(handle);
    }
  });
}

for (const compact of [false, true]) {
  test(`BTW ${compact ? "compact sheet" : "wide side pane"} toggles during generation, retries and restores`, async ({
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
    const window = page.getByTestId("btw-panel").filter({ visible: true });
    const chip = page.getByTestId("btw-chip").filter({ visible: true });
    const panes = page.locator('[data-testid^="workspace-pane-"]:visible');
    const parent = parentChatContainer(page, compact);
    const mainComposer = parent.getByRole("textbox", { name: "Message agent..." });
    const mainUserCount = async () =>
      (await client.fetchAgentTimeline(handle.agentId, { limit: 0 })).entries.filter(
        ({ item }) => item.type === "user_message",
      ).length;
    const closeTab = async () => {
      if (compact)
        await page
          .getByTestId("sheet-tab-header")
          .getByRole("button", { name: "Close", exact: true })
          .click();
      else {
        await page.getByTestId(`workspace-tab-btw_${handle.agentId}`).hover();
        await page.getByTestId(`workspace-btw-close-${handle.agentId}`).click();
      }
    };
    try {
      await submitMessageWithButton(page, "PARENT_A");
      await handle.client.waitForFinish(handle.agentId, 60000);
      await submitMessageWithButton(page, "HOLD_PARENT");
      await expect.poll(() => stub.pending("parent")).toBe(1);
      await expect(parent).toHaveCount(1);
      const scroll = parent.getByTestId("agent-chat-scroll");
      const reading = () =>
        scroll.evaluate((element) => ({
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        }));
      const distance = async () => {
        const rect = await reading();
        return rect.scrollHeight - rect.clientHeight - rect.scrollTop;
      };
      if ((await distance()) > 1) await parent.getByTestId("scroll-to-bottom-button").click();
      await expect.poll(distance).toBeLessThanOrEqual(2);
      const beforeWidth = (await parent.boundingBox())?.width;
      await info.attach("btw-parent-scroll-before", {
        body: JSON.stringify({ ...(await reading()), width: beforeWidth }),
        contentType: "application/json",
      });
      await askBtwFromRunningMainComposer(page, "HOLD_BTW");
      await expect(window).toBeVisible();
      await expect.poll(() => stub.pending("btw")).toBe(1);
      const threadId = await window.getAttribute("aria-label");
      const initialMainUsers = await mainUserCount();
      await expect(window.getByTestId("btw-inject")).toBeDisabled();
      await expect(window.getByTestId("btw-summarize")).toBeDisabled();
      await expect(page.getByTestId("subagents-track-header")).toHaveCount(0);
      if (compact) {
        await expect(page.getByTestId("sheet-tab-header")).toContainText("BTW");
        await expect(page.getByTestId("sheet-tab-body").getByTestId("btw-panel")).toBeVisible();
        await expect(page.getByTestId("sheet-tab-open-as-tab")).toHaveCount(0);
      } else {
        const side = panes.filter({ has: window });
        await expect(side).toHaveCount(1);
        expect(await side.getAttribute("data-testid")).not.toBe(
          await parent.getAttribute("data-testid"),
        );
        await expect(page.getByTestId(`workspace-tab-btw_${handle.agentId}`)).toHaveAttribute(
          "aria-selected",
          "true",
        );
        const left = await parent.boundingBox();
        const right = await side.boundingBox();
        if (!left || !right || !beforeWidth) throw new Error("Missing pane geometry");
        expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
        let widths = { first: 0, second: 0 };
        await expect
          .poll(async () => {
            widths = await parent.evaluate(async (element) => {
              const first = element.getBoundingClientRect().width;
              for (let frame = 0; frame < 4; frame++)
                await new Promise<number>(requestAnimationFrame);
              return { first, second: element.getBoundingClientRect().width };
            });
            return widths.first === widths.second && widths.second < beforeWidth;
          })
          .toBe(true);
        await expect.poll(distance).toBeLessThanOrEqual(2);
        await expect(parent.getByTestId("scroll-to-bottom-button")).toHaveCount(0);
        await info.attach("btw-parent-scroll-after", {
          body: JSON.stringify({ ...(await reading()), widths, beforeWidth }),
          contentType: "application/json",
        });
        await expect(mainComposer).toBeFocused();
      }
      await page.keyboard.type("typed-after");
      await expect(mainComposer).toHaveValue("typed-after");
      await expect(window.getByTestId("btw-composer")).toHaveValue("");
      await mainComposer.fill("");
      await captureBtw(page, info, compact ? "btw-compact-sheet" : "btw-wide-running");
      const beforeHide = stub.requests.length;
      await expect(chip).toHaveAttribute("aria-expanded", "true");
      if (compact) await closeTab();
      else await chip.click();
      await expect(window).toHaveCount(0);
      if (!compact) await expect(panes).toHaveCount(1);
      expect(stub.requests).toHaveLength(beforeHide);
      expect(stub.pending("btw")).toBe(1);
      await chip.click();
      await expect(window).toHaveAttribute("aria-label", threadId ?? "");
      await captureBtw(page, info, "btw-wide-side-pane-reopened");
      stub.release("btw");
      await expect(window).toContainText("BTW_REPLY CONTEXT_A");
      await expect(window.getByTestId("btw-subtitle")).toContainText("pinned turn 1");
      await window.getByTestId("btw-composer").press("Escape");
      expect((await client.fetchAgentTimeline(handle.agentId, { limit: 0 })).agent?.status).toBe(
        "running",
      );
      expect(stub.pending("parent")).toBe(1);
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
      await expect(window.getByTestId("btw-composer")).toHaveValue("FAIL_BTW");
      await askBtw(page, "AFTER_B retry");
      await expect
        .poll(async () => (await client.listProviderSubagents(handle.agentId)).subagents[0]?.status)
        .toBe("completed");
      await expect(window.getByTestId("btw-composer")).toHaveValue("");
      const requests = stub.requests.length;
      const lists = transport.getClientRequestCount("agent.provider_subagents.list.request");
      await transport.drop();
      await transport.waitForBlockedConnection();
      await askBtw(page, "AFTER_B dispatch retry");
      await expect(window.getByTestId("btw-action-feedback")).toContainText(
        /connect|socket|offline/i,
      );
      await closeTab();
      await chip.click();
      await expect(window.getByTestId("btw-action-feedback")).toContainText(
        /connect|socket|offline/i,
      );
      await expect(window.getByTestId("btw-composer")).toHaveValue("AFTER_B dispatch retry");
      expect(stub.requests).toHaveLength(requests);
      transport.restore();
      await transport.waitForServerMessage("agent.provider_subagents.list.response", lists + 1);
      await window.getByTestId("btw-send").click();
      await expect(window.getByTestId("btw-composer")).toHaveValue("");
      await expect
        .poll(async () => (await client.listProviderSubagents(handle.agentId)).subagents[0]?.status)
        .toBe("completed");
      expect(await mainUserCount()).toBe(initialMainUsers);
      await verifyBusyMainDeliveries({ client, handle, stub, window, mainUserCount, info });
      await window.getByTestId("btw-composer").fill("draft line 1\nASCII line 2");
      await window.getByTestId("btw-new").click();
      await expect(window).toHaveAttribute("aria-label", /^btw:/);
      await expect(window).not.toHaveAttribute("aria-label", threadId ?? "");
      await expect(window.getByTestId("btw-composer")).toHaveValue("draft line 1\nASCII line 2");
      if (!compact)
        await expect(page.getByTestId(`workspace-tab-btw_${handle.agentId}`)).toBeVisible();
      await expect(window.getByTestId("btw-inject")).toBeDisabled();
      await expect(window.getByTestId("btw-summarize")).toBeDisabled();
      await expect(window.getByTestId("turn-footer")).toHaveCount(0);
      const replaced = await window.getAttribute("aria-label");
      await window.getByTestId("btw-clear").click();
      await expect(window.getByTestId("btw-empty")).toBeVisible();
      await expect(chip).toHaveCount(0);
      const beforeClearAskRequests = stub.requests.length;
      await askBtw(page, "AFTER_CLEAR");
      await expect(chip).toBeVisible();
      await expect(window).toHaveAttribute("aria-label", /^btw:/);
      await expect(window).not.toHaveAttribute("aria-label", replaced ?? "");
      const afterClearThreadId = await window.getAttribute("aria-label");
      if (!afterClearThreadId) throw new Error("Missing fresh BTW thread after Clear");
      await expect(window.getByText("AFTER_CLEAR", { exact: true })).toBeVisible();
      await expect(window).toContainText("BTW_REPLY CONTEXT_A");
      await expect
        .poll(async () => {
          const history = await client.fetchProviderSubagentTimeline(
            handle.agentId,
            afterClearThreadId,
            { direction: "tail", limit: 200 },
          );
          return history.rows.flatMap(({ item }) =>
            item.type === "user_message" ? [item.text] : [],
          );
        })
        .toEqual(["AFTER_CLEAR"]);
      expect(stub.requests).toHaveLength(beforeClearAskRequests + 1);
      const clearAskRequest = stub.requests[beforeClearAskRequests];
      if (!clearAskRequest) throw new Error("Missing model request for the ask after Clear");
      expect(JSON.stringify(clearAskRequest.messages)).toContain("<btw>");
      expect(JSON.stringify(clearAskRequest.messages.at(-1)?.content)).toContain("AFTER_CLEAR");
      await info.attach("btw-after-clear-correlation", {
        body: JSON.stringify({
          threadId: afterClearThreadId,
          request: clearAskRequest,
          history: await client.fetchProviderSubagentTimeline(handle.agentId, afterClearThreadId, {
            direction: "tail",
            limit: 200,
          }),
        }),
        contentType: "application/json",
      });
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

test("BTW wide side pane lifecycle survives resize, reload and restart", async ({
  page,
  btwRuntime,
}, info) => {
  test.setTimeout(240000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const handle = await launchBtwAgent(page, btwRuntime);
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "btw-lifecycle" });
  const panel = page.getByTestId("btw-panel").filter({ visible: true });
  const chip = page.getByTestId("btw-chip").filter({ visible: true });
  try {
    await submitMessageWithButton(page, "PARENT_A");
    await handle.client.waitForFinish(handle.agentId, 60000);
    await submitMessageWithButton(page, "/btw AFTER_B");
    await expect(panel).toContainText("BTW_REPLY AFTER_B");
    const threadId = await panel.getAttribute("aria-label");
    if (!threadId) throw new Error("Missing thread id");
    const tab = page.getByTestId(`workspace-tab-btw_${handle.agentId}`);
    const paneId = await panel
      .locator('xpath=ancestor::*[starts-with(@data-testid,"workspace-pane-")]')
      .getAttribute("data-testid");
    await panel.getByTestId("btw-composer").fill("draft line 1\nASCII line 2");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.getByTestId("btw-composer")).toHaveValue("draft line 1\nASCII line 2");
    await expect(page.getByTestId("sheet-tab-header")).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    const mainComposer = page.getByRole("textbox", { name: "Message agent..." });
    await mainComposer.click();
    await expect(mainComposer).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(panel.getByTestId("btw-composer")).toHaveValue("draft line 1\nASCII line 2");
    await expect(page.getByTestId("sheet-tab-header")).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(panel).toBeVisible();
    expect(
      await panel
        .locator('xpath=ancestor::*[starts-with(@data-testid,"workspace-pane-")]')
        .getAttribute("data-testid"),
    ).toBe(paneId);
    await expect(panel.getByTestId("btw-composer")).toHaveValue("draft line 1\nASCII line 2");
    const before = await client.fetchProviderSubagentTimeline(handle.agentId, threadId, {
      limit: 0,
    });
    const rows = before.rows.map(({ item }) => item);
    await client.refreshAgent(handle.agentId);
    await expect(panel).toHaveAttribute("aria-label", threadId);
    expect(
      (await client.fetchProviderSubagentTimeline(handle.agentId, threadId, { limit: 0 })).rows.map(
        ({ item }) => item,
      ),
    ).toEqual(rows);
    await page.getByTestId(`workspace-tab-btw_${handle.agentId}`).hover();
    await page.getByTestId(`workspace-btw-close-${handle.agentId}`).click();
    await page.reload();
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await expect(panel).toHaveCount(0);
      await page.waitForTimeout(100);
    }
    await chip.click();
    await expect(tab).toBeVisible();
    await page.reload();
    await expect(panel).toHaveAttribute("aria-label", threadId);
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
    await expect(panel).toHaveAttribute("aria-label", threadId);
    await expect(panel).toContainText("BTW_REPLY AFTER_B");
    expect(
      (await client.fetchProviderSubagentTimeline(handle.agentId, threadId, { limit: 0 })).rows.map(
        ({ item }) => item,
      ),
    ).toEqual(rows);
    await captureBtw(page, info, "btw-restored-after-restart");
  } finally {
    await client.close();
    await closeAgent(handle);
  }
});

for (const compact of [false, true]) {
  test(`BTW ${compact ? "compact" : "wide"} explicit sends land once and output preserves the reader`, async ({
    page,
    btwRuntime,
  }, info) => {
    test.setTimeout(120000);
    const stub = btwRuntime.stub;
    if (!stub) throw new Error("Missing deterministic HTTP fixture");
    await page.setViewportSize(
      compact ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    );
    const transport = await installDaemonWebSocketGate(page);
    const handle = await launchBtwAgent(page, btwRuntime);
    const window = page.getByTestId("btw-panel").filter({ visible: true });
    const scroller = window.getByTestId("agent-chat-scroll");
    const proof = [];
    try {
      await submitMessageWithButton(page, "PARENT_A");
      await handle.client.waitForFinish(handle.agentId, 60000);
      await submitMessageWithButton(page, "/btw HOLD_BTW initial viewport question");
      await expect.poll(() => stub.pending("btw")).toBe(1);
      await expect(window.getByTestId("btw-stop")).toBeVisible();
      await expectBtwTextInViewport(
        scroller.getByText("HOLD_BTW initial viewport question", { exact: true }),
      );
      stub.release("btw");
      await revealBtwText(page, scroller.getByText("BTW_REPLY CONTEXT_A", { exact: true }).last());
      for (const index of [1, 2, 3, 4]) {
        const question = `HOLD_BTW AFTER_B viewport question ${index}`;
        await askBtw(page, question);
        await expect.poll(() => stub.pending("btw")).toBe(1);
        await expect(window.getByTestId("btw-stop")).toBeVisible();
        const prompt = scroller.getByText(question, { exact: true });
        await expect(prompt).toBeVisible();
        proof.push({ phase: `send-${index}`, ...(await btwViewportGeometry(prompt)) });
        await expectBtwTextInViewport(prompt);
        const beforeOutput = await btwViewportGeometry(prompt);
        const samplesPromise = scroller.evaluate(async (element) => {
          const samples = [];
          for (let frame = 0; frame < 60; frame += 1) {
            await new Promise<number>(requestAnimationFrame);
            samples.push({
              frame,
              scrollTop: element.scrollTop,
              scrollHeight: element.scrollHeight,
              rows: Array.from(element.querySelectorAll("[data-history-row-id]"), (row) => ({
                id: row.getAttribute("data-history-row-id"),
                top: row.getBoundingClientRect().top,
                height: row.getBoundingClientRect().height,
              })),
            });
          }
          return samples;
        });
        stub.release("btw");
        await expect(scroller.getByText("BTW_REPLY AFTER_B", { exact: true })).toHaveCount(index);
        await expect(window.getByTestId("btw-stop")).toHaveCount(0);
        await prompt.evaluate(async () => {
          for (let frame = 0; frame < 4; frame += 1) {
            await new Promise<number>(requestAnimationFrame);
          }
        });
        const afterOutput = await btwViewportGeometry(prompt);
        const samples = await samplesPromise;
        proof.push({ phase: `output-${index}`, ...afterOutput, samples });
        const promptRow = beforeOutput.rows.at(-1);
        if (!promptRow) throw new Error("Missing submitted prompt row");
        for (const sample of samples) {
          expect(Math.abs(sample.scrollTop - beforeOutput.scrollTop)).toBeLessThanOrEqual(1);
          const sampledPrompt = sample.rows.find((row) => row.id === promptRow.id);
          expect(sampledPrompt?.top).toBeCloseTo(promptRow.top, 0);
        }
        expect(afterOutput.scrollTop).toBeCloseTo(beforeOutput.scrollTop, 0);
        await revealBtwText(page, scroller.getByText("BTW_REPLY AFTER_B", { exact: true }).last());
      }
      const question = "HOLD_BTW AFTER_B reader stays above new output";
      await askBtw(page, question);
      await expect.poll(() => stub.pending("btw")).toBe(1);
      await expect(window.getByTestId("btw-stop")).toBeVisible();
      const prompt = scroller.getByText(question, { exact: true });
      await expectBtwTextInViewport(prompt);
      await scroller.hover();
      await page.mouse.wheel(0, -10000);
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
      const before = await btwViewportGeometry(prompt);
      stub.release("btw");
      await expect(scroller.getByText("BTW_REPLY AFTER_B", { exact: true })).toHaveCount(5);
      const after = await btwViewportGeometry(prompt);
      proof.push(
        { phase: "reader-before-output", ...before },
        { phase: "reader-after-output", ...after },
      );
      expect(after.scrollTop).toBe(before.scrollTop);
      expect(after.target.top).toBeCloseTo(before.target.top, 0);
      const reply = scroller.getByText("BTW_REPLY AFTER_B", { exact: true }).last();
      await window.getByTestId("scroll-to-bottom-button").click();
      await expectBtwTextInViewport(reply);
      proof.push({ phase: "explicit-jump", ...(await btwViewportGeometry(reply)) });
      transport.holdNextClientRequest("send_agent_message_request");
      const delayedQuestion = "HOLD_BTW AFTER_B delayed question after reader gesture";
      await askBtw(page, delayedQuestion);
      await transport.waitForHeldClientRequest();
      await scroller.hover();
      await page.mouse.wheel(0, -10000);
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
      const beforeAdmission = await btwViewportGeometry(reply);
      transport.releaseHeldClientRequest();
      await expect.poll(() => stub.pending("btw")).toBe(1);
      await expect(window.getByTestId("btw-stop")).toBeVisible();
      await expect(scroller.getByText(delayedQuestion, { exact: true })).toBeAttached();
      const afterAdmission = await btwViewportGeometry(reply);
      proof.push(
        { phase: "gesture-before-admission", ...beforeAdmission },
        { phase: "canonical-after-gesture", ...afterAdmission },
      );
      expect(afterAdmission.scrollTop).toBe(beforeAdmission.scrollTop);
      expect(afterAdmission.target.top).toBeCloseTo(beforeAdmission.target.top, 0);
      stub.release("btw");
      await expect(scroller.getByText("BTW_REPLY AFTER_B", { exact: true })).toHaveCount(6);
      const afterDelayedOutput = await btwViewportGeometry(reply);
      expect(afterDelayedOutput.scrollTop).toBe(beforeAdmission.scrollTop);
      await window.getByTestId("scroll-to-bottom-button").click();
      const latestReply = scroller.getByText("BTW_REPLY AFTER_B", { exact: true }).last();
      await expectBtwTextInViewport(latestReply);
      proof.push({
        phase: "delayed-answer-explicit-jump",
        ...(await btwViewportGeometry(latestReply)),
      });
      await captureBtw(page, info, `btw-${compact ? "compact" : "wide"}-answer-in-viewport`);
      const threadId = await window.getAttribute("aria-label");
      if (!threadId) throw new Error("Missing current thread for reopen proof");
      const reopen = () =>
        reopenBtwViewport({ page, compact, agentId: handle.agentId, threadId, transport });
      const reopenedQuestion = "HOLD_BTW AFTER_B output after close reopen";
      await askBtw(page, reopenedQuestion);
      await expect.poll(() => stub.pending("btw")).toBe(1);
      await expectBtwTextInViewport(scroller.getByText(reopenedQuestion, { exact: true }));
      const outputEntry = await reopen();
      proof.push({ phase: "reopen-during-generation-entry", ...outputEntry });
      const reopenedOutputFrames = btwScrollFrames(scroller);
      stub.release("btw");
      await expect(scroller.getByText("BTW_REPLY AFTER_B", { exact: true })).toHaveCount(7);
      await expect(window.getByTestId("btw-stop")).toHaveCount(0);
      const outputFrames = [
        ...(await reopenedOutputFrames),
        ...(await btwScrollFrames(scroller, 8)),
      ];
      expectBtwViewportHeld(outputEntry.baseline, outputFrames);
      proof.push({ phase: "reopen-output-and-completion", frames: outputFrames });
      transport.holdNextClientRequest("send_agent_message_request");
      const reopenedPendingQuestion = "HOLD_BTW AFTER_B admission after close reopen";
      await askBtw(page, reopenedPendingQuestion);
      await transport.waitForHeldClientRequest();
      const pendingEntry = await reopen();
      proof.push({ phase: "reopen-before-admission-entry", ...pendingEntry });
      const admissionFramesPromise = btwScrollFrames(scroller);
      transport.releaseHeldClientRequest();
      await expect.poll(() => stub.pending("btw")).toBe(1);
      await expect(scroller.getByText(reopenedPendingQuestion, { exact: true })).toBeAttached();
      const admissionFrames = [
        ...(await admissionFramesPromise),
        ...(await btwScrollFrames(scroller, 8)),
      ];
      expectBtwViewportHeld(pendingEntry.baseline, admissionFrames);
      proof.push({ phase: "reopen-late-admission-no-landing", frames: admissionFrames });
      const pendingOutputFramesPromise = btwScrollFrames(scroller);
      stub.release("btw");
      await expect(scroller.getByText("BTW_REPLY AFTER_B", { exact: true })).toHaveCount(8);
      await expect(window.getByTestId("btw-stop")).toHaveCount(0);
      const pendingOutputFrames = [
        ...(await pendingOutputFramesPromise),
        ...(await btwScrollFrames(scroller, 8)),
      ];
      expectBtwViewportHeld(pendingEntry.baseline, pendingOutputFrames);
      proof.push({ phase: "reopen-late-output-no-landing", frames: pendingOutputFrames });
      await captureBtw(page, info, `btw-${compact ? "compact" : "wide"}-reopened-reader`);
    } finally {
      const proofPath = info.outputPath("btw-scroll-geometry.json");
      await writeFile(proofPath, JSON.stringify(proof, null, 2));
      await info.attach("btw-scroll-geometry", {
        path: proofPath,
        contentType: "application/json",
      });
      transport.restore();
      stub.release("btw");
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
  const window = page.getByTestId("btw-panel").filter({ visible: true });
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
    `BTW absent extension ${compact ? "compact" : "wide"} keeps the main fallback without a tab or pill`,
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
        await expect(page.getByTestId("btw-panel")).toHaveCount(0);
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
        await expect(page.getByTestId("btw-panel")).toHaveCount(0);
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

test("BTW wide Send shortcut follows the existing preference", async ({
  page,
  btwRuntime,
}, info) => {
  test.setTimeout(240000);
  const stub = btwRuntime.stub;
  if (!stub) throw new Error("Missing deterministic HTTP fixture");
  await page.setViewportSize({ width: 1440, height: 900 });
  const transport = await installDaemonWebSocketGate(page);
  const handle = await launchBtwAgent(page, btwRuntime);
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "btw-keys" });
  const window = page.getByTestId("btw-panel").filter({ visible: true });
  const composer = window.getByTestId("btw-composer");
  const observations: object[] = [];
  const count = () => btwRequests(btwRuntime).length;
  const mainRequests = () =>
    stub.requests.filter((request) => !JSON.stringify(request.messages).includes("<btw>"));
  const mainUsers = async () =>
    (await client.fetchAgentTimeline(handle.agentId, { limit: 0 })).entries.filter(
      ({ item }) => item.type === "user_message",
    ).length;
  const observe = async (step: string) => {
    observations.push({
      step,
      count: count(),
      value: await composer.inputValue(),
      thread: await window.getAttribute("aria-label"),
    });
    await info.attach(`observation-${step}`, {
      body: JSON.stringify(observations.at(-1)),
      contentType: "application/json",
    });
  };
  const completed = async () => {
    await expect
      .poll(async () => (await client.listProviderSubagents(handle.agentId)).subagents[0]?.status)
      .toBe("completed");
    await expect(composer).toBeEditable();
  };
  const submitDraft = async (text: string, key: string) => {
    const before = count();
    await pressBtwComposerKey(page, key);
    await expect.poll(count).toBe(before + 1);
    await expect(composer).toHaveValue("");
    await expect(window.getByTestId("agent-chat-scroll")).toContainText(text);
    const request = btwRequests(btwRuntime).at(-1);
    expect(JSON.stringify(request?.messages.at(-1)?.content)).toContain(
      JSON.stringify(text).slice(1, -1),
    );
    await completed();
    expect(count()).toBe(before + 1);
    await observe(key + text);
  };
  const sent = async (text: string, key: string) => {
    await composer.fill(text);
    await submitDraft(text, key);
  };
  const changeShortcut = async (option: string) => {
    const thread = await window.getAttribute("aria-label");
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await toggleSettingsWithShortcut(page);
    await selectSendingOption(page, "Send shortcut", option);
    await toggleSettingsWithShortcut(page);
    const minimized = !(await window.isVisible());
    if (minimized) await page.getByTestId("btw-chip").filter({ visible: true }).click();
    await expect(window).toHaveAttribute("aria-label", thread ?? "");
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    observations.push({ option, minimized });
  };
  try {
    await submitMessageWithButton(page, "PARENT_A");
    await expect(
      page.getByTestId("assistant-message").filter({ hasText: "PARENT_A_FINISHED" }),
    ).toBeVisible({ timeout: 60000 });
    await handle.client.waitForFinish(handle.agentId, 60000);
    await submitMessageWithButton(page, "/btw first question");
    await expect(window).toHaveAttribute("aria-label", /^btw:/);
    await expect(window).toContainText("BTW_REPLY CONTEXT_A");
    await completed();
    expect((await recordedBtwStates(btwRuntime)).at(-1)?.status).toBe("idle");
    expect((await recordedBtwStates(btwRuntime)).at(-1)?.revision).toBeGreaterThanOrEqual(2);
    // Control proves real producer multiline readiness before testing the missing keyboard feature.
    const control = "AFTER_B control first\ncontrol second";
    const beforeControl = count();
    await askBtw(page, control);
    await expect.poll(count).toBe(beforeControl + 1);
    await expect(composer).toHaveValue("");
    expect(JSON.stringify(btwRequests(btwRuntime).at(-1)?.messages.at(-1)?.content)).toContain(
      JSON.stringify(control).slice(1, -1),
    );
    await expect(window.getByTestId("agent-chat-scroll")).toContainText(control);
    await completed();
    await observe("J2-multiline-button-ready");
    const beforeEmpty = count();
    await expect(window.getByTestId("btw-send")).toBeDisabled();
    await pressBtwComposerKey(page, "Shift+Control+Enter");
    await composer.pressSequentially("AFTER_B one");
    await observe("J3-empty-line-break");
    await expect(composer).toHaveValue("\nAFTER_B one");
    expect(count()).toBe(beforeEmpty);
    await sent("AFTER_B enter", "Enter");
    const beforeShift = count();
    await composer.fill("AFTER_B line");
    await pressBtwComposerKey(page, "Shift+Enter");
    await composer.pressSequentially("two");
    await expect(composer).toHaveValue("AFTER_B line\ntwo");
    expect(count()).toBe(beforeShift);
    await sent("AFTER_B ctrl", "Control+Enter");
    await sent("AFTER_B meta", "Meta+Enter");
    await changeShortcut(process.platform === "darwin" ? "⌘+Enter" : "Ctrl+Enter");
    const beforeLines = count();
    await composer.fill("AFTER_B first");
    await composer.press("Enter");
    await composer.pressSequentially("AFTER_B second");
    await composer.press("Shift+Control+Enter");
    await composer.pressSequentially("third");
    await composer.press("Shift+Meta+Enter");
    await composer.pressSequentially("fourth");
    const lines = "AFTER_B first\nAFTER_B second\nthird\nfourth";
    await expect(composer).toHaveValue(lines);
    expect(count()).toBe(beforeLines);
    await observe("J6-multiline");
    await submitDraft(lines, "Control+Enter");
    await sent("AFTER_B meta2", "Meta+Enter");
    await changeShortcut("Enter");
    const beforeBack = count();
    await composer.fill("AFTER_B again");
    await composer.press("Shift+Meta+Enter");
    await composer.pressSequentially("back");
    await expect(composer).toHaveValue("AFTER_B again\nback");
    expect(count()).toBe(beforeBack);
    await submitDraft("AFTER_B again\nback", "Enter");
    const beforeDouble = count();
    await composer.fill("   ");
    await composer.press("Control+Enter");
    await expect(composer).toHaveValue("   ");
    expect(count()).toBe(beforeDouble);
    await composer.fill("AFTER_B double");
    await composer.press("Control+Enter");
    await composer.press("Control+Enter");
    await expect.poll(count).toBe(beforeDouble + 1);
    await expect(composer).toHaveValue("");
    await completed();
    await observe("J9-double");
    const beforeOffline = count();
    const listRequests = transport.getClientRequestCount("agent.provider_subagents.list.request");
    await transport.drop();
    await transport.waitForBlockedConnection();
    await composer.fill("AFTER_B offline");
    await composer.press("Control+Enter");
    await expect(window.getByTestId("btw-action-feedback")).toContainText(
      /connect|socket|offline/i,
    );
    await expect(composer).toHaveValue("AFTER_B offline");
    expect(count()).toBe(beforeOffline);
    transport.restore();
    await transport.waitForServerMessage(
      "agent.provider_subagents.list.response",
      listRequests + 1,
    );
    await submitDraft("AFTER_B offline", "Control+Enter");
    await submitMessageWithButton(page, "HOLD_PARENT");
    await expect.poll(() => stub.pending("parent")).toBe(1);
    const main = page.getByRole("textbox", { name: "Message agent..." });
    await main.fill("MAIN_DRAFT_UNTOUCHED");
    const parents = mainRequests().length;
    const users = await mainUsers();
    await sent("AFTER_B during parent", "Control+Enter");
    await expect(window).toContainText("BTW_REPLY AFTER_B");
    expect(stub.pending("parent")).toBe(1);
    expect(mainRequests()).toHaveLength(parents);
    expect((await client.fetchAgentTimeline(handle.agentId, { limit: 0 })).agent?.status).toBe(
      "running",
    );
    await expect(main).toHaveValue("MAIN_DRAFT_UNTOUCHED");
    expect(await mainUsers()).toBe(users);
    stub.release("parent");
    await handle.client.waitForFinish(handle.agentId, 60000);
    await observe("J12-parent-finished");
    await captureBtw(page, info, "btw-wide-send-shortcut");
  } finally {
    const evidence = info.outputPath("send-shortcut-evidence.json");
    await writeFile(
      evidence,
      JSON.stringify(
        {
          revision: btwRuntime.revision,
          observations,
          requestQuestions: btwRequests(btwRuntime).map((request) => request.messages.at(-1)),
        },
        null,
        2,
      ),
    );
    await info.attach("send-shortcut-evidence", {
      path: evidence,
      contentType: "application/json",
    });
    transport.restore();
    stub.release("parent");
    stub.release("btw");
    await client.close();
    await closeAgent(handle);
  }
});

for (const sendShortcut of ["enter", "mod-enter"]) {
  test(`BTW compact Send shortcut keeps editing (${sendShortcut})`, async ({
    page,
    btwRuntime,
  }, info) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((shortcut) => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ sendShortcut: shortcut }));
    }, sendShortcut);
    const handle = await launchBtwAgent(page, btwRuntime);
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "btw-compact-keys" });
    const window = page.getByTestId("btw-panel").filter({ visible: true });
    const composer = window.getByTestId("btw-composer");
    try {
      await submitMessageWithButton(page, "PARENT_A");
      await handle.client.waitForFinish(handle.agentId, 60000);
      await submitMessageWithButton(page, "/btw first question");
      await expect(window).toContainText("BTW_REPLY CONTEXT_A");
      await expect
        .poll(async () => (await recordedBtwStates(btwRuntime)).at(-1)?.status)
        .toBe("idle");
      await expect
        .poll(async () => (await client.listProviderSubagents(handle.agentId)).subagents[0]?.status)
        .toBe("completed");
      await waitForSettledPosition(window);
      const before = btwRequests(btwRuntime).length;
      await composer.fill("AFTER_B compact");
      await composer.press("Enter");
      await expect(composer).toHaveValue("AFTER_B compact\n");
      await composer.press("Control+Enter");
      await composer.press("Meta+Enter");
      await expect(composer).toHaveValue("AFTER_B compact\n");
      expect(btwRequests(btwRuntime)).toHaveLength(before);
      await window.getByTestId("btw-send").click();
      await expect.poll(() => btwRequests(btwRuntime).length).toBe(before + 1);
      await expect(composer).toHaveValue("");
      await expect(window.getByTestId("agent-chat-scroll")).toContainText("AFTER_B compact");
      await captureBtw(page, info, "btw-compact-send-shortcut");
    } finally {
      await client.close();
      await closeAgent(handle);
    }
  });
}
