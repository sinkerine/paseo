import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { expect, type Locator, type Page } from "@playwright/test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { submitMessageWithButton } from "../support/helpers/composer";
import {
  openSessions,
  clickSessionRow,
  expectArchivedAgentFocused,
} from "../support/helpers/archive-tab";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { closeAgent } from "../support/helpers/rewind-flow";
import {
  btwBrowserTest,
  launchBtwAgent,
  captureBtw,
  askBtwFromRunningMainComposer,
  askBtw,
} from "../support/helpers/pi-btw";

const pluginDir = process.env.PASEO_BETTER_PASEO_SOURCE;
if (!pluginDir)
  throw new Error(
    "NEEDS_CONTEXT: set PASEO_BETTER_PASEO_SOURCE to the Better Paseo plugin directory",
  );
const test = btwBrowserTest(false);
test("capability: Better Paseo selection bar renders on assistant reply", async ({
  page,
  btwRuntime,
}, info) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "btw-selection" });
  const previous = await client.getDaemonConfig();
  let handle: Awaited<ReturnType<typeof launchBtwAgent>> | undefined;
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDir);
    handle = await launchBtwAgent(page, btwRuntime);
    await submitMessageWithButton(page, "PARENT_A");
    const reply = page
      .locator("[data-bcselection]")
      .filter({ hasText: "PARENT_A_FINISHED" })
      .last();
    await expect(reply).toBeVisible({ timeout: 60000 });
    await reply.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const start = node.textContent?.indexOf("PARENT_A_FINISHED") ?? -1;
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + "PARENT_A_FINISHED".length);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        return;
      }
      throw new Error("Missing reply text node");
    });
    const bar = page.locator("[data-bcselectionbar]");
    await expect(bar).toBeVisible();
    expect(
      await bar.evaluate((element) =>
        Array.from(element.shadowRoot!.querySelectorAll("button:not([hidden])"), (button) =>
          button.getAttribute("aria-label"),
        ),
      ),
    ).toEqual(["Copy", "Add to chat"]);
    await captureBtw(page, info, "00-capability-selection-bar");
  } finally {
    if (handle) await closeAgent(handle);
    await client.removePlugin("better-paseo");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
  }
});

test("host contract: data-btw-thread lifecycle and malformed detail rejection", async ({
  page,
  btwRuntime,
}, info) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const directory = await mkdtemp(path.join(btwRuntime.root, "contract-plugin-"));
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "btw-contract" });
  const previous = await client.getDaemonConfig();
  let handle: Awaited<ReturnType<typeof launchBtwAgent>> | undefined;
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "btw-contract-e2e", requirements: pluginRequirements }),
  );
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `import React from "react";
import { z } from "zod";
export default function contribute(client) {
  client.addTimelineTransformer({ id: "reply", query: { itemType: "assistant_message" }, transform({ item }) {
    return { items: [{ type: "plugin", kind: "reply", version: 1, data: { text: item.text } }] };
  } });
  client.addTimelineRenderer({ kind: "reply", version: 1, schema: z.object({ text: z.string() }),
    Component: ({ item }) => <div data-bcselection="">{item.data.text}</div> });
  return () => {};
}`,
  );
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    handle = await launchBtwAgent(page, btwRuntime);
    await expect(page.locator("[data-btw-thread]")).toHaveCount(0);
    await submitMessageWithButton(page, "RICH_PARENT");
    const rich = page.locator("[data-bcselection]").filter({ hasText: "PARENT_RICH_PROSE" });
    await expect(rich).toBeVisible({ timeout: 60000 });
    await expect(rich).toContainText("const answer = 42;");
    await expect(rich).toContainText("GUTTER_LINE_ONE\nGUTTER_LINE_TWO");
    await expect(rich).toContainText("| Latency | 42ms |");
    await handle.client.waitForFinish(handle.agentId, 60000);
    await submitMessageWithButton(page, "HOLD_PARENT");
    const stub = btwRuntime.stub;
    if (!stub) throw new Error("Missing deterministic HTTP fixture");
    await expect.poll(() => stub.pending("parent")).toBe(1);
    await askBtwFromRunningMainComposer(page, "CONTRACT_Q");
    stub.release("parent");
    const window = page.getByTestId("btw-window").filter({ visible: true });
    await expect(window).toContainText("BTW_REPLY CONTEXT_A");
    await expect(window.getByTestId("btw-stop")).toHaveCount(0);
    const target = page.locator("[data-btw-thread]");
    await expect(target).toHaveCount(1);
    const composer = window.getByTestId("btw-composer");
    for (const detail of [{ text: "" }, null, {}, { text: 42 }]) {
      expect(
        await target.evaluate(
          (element, payload) =>
            element.dispatchEvent(
              new CustomEvent("paseo:btw-insert", {
                bubbles: true,
                cancelable: true,
                detail: payload,
              }),
            ),
          detail,
        ),
      ).toBe(true);
      await expect(composer).toHaveValue("");
    }
    expect(
      await target.evaluate((element) => {
        const event = new CustomEvent("paseo:btw-insert", {
          bubbles: true,
          cancelable: false,
          detail: { text: "> NONCANCELABLE\n\n" },
        });
        return { dispatched: element.dispatchEvent(event), prevented: event.defaultPrevented };
      }),
    ).toEqual({ dispatched: true, prevented: false });
    await expect(composer).toHaveValue("");
    await window.getByTestId("btw-minimize").click();
    await expect(window).toBeHidden();
    expect(
      await target.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent("paseo:btw-insert", {
            bubbles: true,
            cancelable: true,
            detail: { text: "> CONTRACT_OK\n\n" },
          }),
        ),
      ),
    ).toBe(false);
    await expect(window).toBeVisible();
    await expect(composer).toHaveValue("> CONTRACT_OK\n\n");
    await expect(composer).toBeFocused();
    expect(
      await composer.evaluate((input: HTMLTextAreaElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual([15, 15]);
    await captureBtw(page, info, "00-host-contract-added");
    await window.getByTestId("btw-clear").click();
    await expect(target).toHaveCount(0);
  } finally {
    if (handle) await closeAgent(handle);
    await client.removePlugin("btw-contract-e2e");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const basicButtons = ["Copy", "Add to chat"];
const btwButtons = [...basicButtons, "Add to BTW"];

async function selectText(target: Locator, text: string) {
  await target.scrollIntoViewIfNeeded();
  await waitForSettledPosition(target);
  await target.evaluate((element, needle) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Node[] = [];
    let nextNode: Node | null;
    while ((nextNode = walker.nextNode())) nodes.push(nextNode);
    const selectedContent = nodes.map((part) => part.textContent ?? "").join("");
    const start = selectedContent.indexOf(needle);
    if (start < 0) throw new Error(`Missing selection text: ${needle}`);
    const range = document.createRange();
    let offset = 0;
    let started = false;
    for (const node of nodes) {
      const end = offset + (node.textContent?.length ?? 0);
      if (!started && start < end) {
        range.setStart(node, start - offset);
        started = true;
      }
      if (started && start + needle.length <= end) {
        range.setEnd(node, start + needle.length - offset);
        break;
      }
      offset = end;
    }
    const selection = globalThis.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, text);
}
async function expectButtons(page: Page, labels: string[]) {
  const bar = page.locator("[data-bcselectionbar]");
  await expect(bar).toBeVisible();
  await expect
    .poll(() =>
      bar.evaluate((element) =>
        Array.from(element.shadowRoot!.querySelectorAll("button:not([hidden])"), (button) =>
          button.getAttribute("aria-label"),
        ),
      ),
    )
    .toEqual(labels);
}
async function pressBar(page: Page, label: string, feedback?: string) {
  const button = page
    .locator("[data-bcselectionbar]")
    .getByRole("button", { name: label, exact: true });
  await button.click();
  if (feedback) await expect(button).toHaveText(feedback);
}
async function expectDraftFocus(composer: Locator, text: string) {
  await expect(composer).toHaveValue(text);
  await expect(composer).toBeFocused();
  await expect
    .poll(() =>
      composer.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd]),
    )
    .toEqual([text.length, text.length]);
}
const richProse = (page: Page) =>
  page.locator("[data-bcselection]").filter({ hasText: "PARENT_RICH_PROSE" }).first();
const parentReply = (page: Page) =>
  page.locator("[data-bcselection]").filter({ hasText: "PARENT_A_FINISHED" }).last();
const activeWindow = (page: Page) => page.getByTestId("btw-window").filter({ visible: true });
async function createThread(
  page: Page,
  runtime: Parameters<typeof launchBtwAgent>[1],
  handle: Awaited<ReturnType<typeof launchBtwAgent>>,
  question: string,
  scope: Page | Locator = page,
) {
  if (!runtime.stub) throw new Error("Missing deterministic HTTP fixture");
  await handle.client.waitForFinish(handle.agentId, 60000);
  const mainComposer = scope.getByRole("textbox", { name: "Message agent...", exact: true });
  await mainComposer.fill("HOLD_PARENT");
  await scope.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => runtime.stub!.pending("parent")).toBe(1);
  await mainComposer.fill(`/btw ${question}`);
  await scope.getByRole("button", { name: "Send and steer", exact: true }).click();
  await expect(activeWindow(page)).toContainText("BTW_REPLY CONTEXT_A");
  await expect(activeWindow(page).getByTestId("btw-stop")).toHaveCount(0);
  await waitForSettledPosition(activeWindow(page));
  runtime.stub.release("parent");
  await handle.client.waitForFinish(handle.agentId, 60000);
}
async function gutterSelection(page: Page) {
  await page.getByRole("button", { name: "Open Markdown in a window", exact: true }).last().click();
  await page.getByRole("button", { name: "Show raw text", exact: true }).click();
  const gutter = page.getByTestId("preview-line-numbers");
  await expect(gutter).toBeVisible();
  await gutter.click({ position: { x: 8, y: 8 } });
}
async function closePreview(page: Page) {
  await page.getByRole("button", { name: "Close preview", exact: true }).click();
}

test("journey 1: real plugin wide selection surfaces, lifecycle and isolation", async ({
  page,
  btwRuntime,
}, info) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(10000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  const transport = await installDaemonWebSocketGate(page);
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "btw-real-wide" });
  const previous = await client.getDaemonConfig();
  const handles: Awaited<ReturnType<typeof launchBtwAgent>>[] = [];
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDir);
    const a = await launchBtwAgent(page, btwRuntime);
    handles.push(a);
    await expect(page.locator("[data-btw-thread]")).toHaveCount(0);
    await submitMessageWithButton(page, "RICH_PARENT");
    const prose = richProse(page);
    await expect(prose).toContainText("PARENT_RICH_PROSE", { timeout: 60000 });
    const code = page.locator("[data-bccode]").filter({ hasText: "const answer = 42;" }).first();
    const cell = page
      .getByTestId("markdown-table-cell")
      .filter({ hasText: /^42ms$/ })
      .first();
    await expect(code).toBeVisible();
    await expect(cell).toBeVisible();
    await a.client.waitForFinish(a.agentId, 60000);
    await selectText(prose, "PARENT_RICH_PROSE");
    await expectButtons(page, basicButtons);
    await captureBtw(page, info, "01-wide-no-thread");
    await selectText(code, "const answer = 42;");
    await expectButtons(page, basicButtons);
    await gutterSelection(page);
    await expectButtons(page, basicButtons);
    await closePreview(page);
    await cell.dblclick();
    const menu = page.getByTestId("table-selection-menu-row");
    await expect(menu.getByRole("button")).toHaveText(["Copy selected", "Add to chat"]);
    await expect(menu.getByRole("button", { name: "Add to BTW" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await createThread(page, btwRuntime, a, "FIRST_Q");
    const window = activeWindow(page);
    const composer = window.getByTestId("btw-composer");
    await window.getByTestId("btw-minimize").click();
    await selectText(prose, "PARENT_RICH_PROSE");
    await expectButtons(page, btwButtons);
    await captureBtw(page, info, "02-wide-chip-visible");
    await pressBar(page, "Add to BTW", "Added");
    await expectDraftFocus(composer, "> PARENT_RICH_PROSE\n\n");
    await expect(page.locator("[data-composer-input]:visible")).toHaveValue("");
    await composer.press("End");
    await composer.pressSequentially("Note");
    await selectText(code, "const answer = 42;");
    await expectButtons(page, btwButtons);
    await pressBar(page, "Add to BTW", "Added");
    await expectDraftFocus(
      composer,
      "> PARENT_RICH_PROSE\n\nNote\n\n```\nconst answer = 42;\n```\n\n",
    );
    await captureBtw(page, info, "02b-wide-code-added");
    await composer.fill("");
    await window.getByTestId("btw-minimize").click();
    await gutterSelection(page);
    await expectButtons(page, btwButtons);
    await pressBar(page, "Add to BTW", "Added");
    await expectDraftFocus(composer, "```\nGUTTER_LINE_ONE\n```\n\n");
    await captureBtw(page, info, "02c-wide-gutter-added");
    await closePreview(page);
    await window.getByTestId("btw-minimize").click();
    await cell.dblclick();
    await expect(menu.getByRole("button")).toHaveText([
      "Copy selected",
      "Add to chat",
      "Add to BTW",
    ]);
    await captureBtw(page, info, "03-table-menu-btw");
    await expect
      .poll(
        async () => {
          const bounds = await menu.boundingBox();
          const frame = await page.getByTestId("table-selection-menu-animation").boundingBox();
          return bounds !== null && frame !== null && frame.width >= Math.ceil(bounds.width) + 1;
        },
        { message: "Expected the selected-cell menu to finish expanding" },
      )
      .toBe(true);
    await menu.getByRole("button", { name: "Add to BTW", exact: true }).click();
    const quoted = "```\nGUTTER_LINE_ONE\n```\n\n> 42ms\n\n";
    await expectDraftFocus(composer, quoted);
    await expect(menu.getByRole("button", { name: "Add to BTW" })).toHaveCount(0);
    const users = async () =>
      (await client.fetchAgentTimeline(a.agentId, { limit: 0 })).entries.filter(
        ({ item }) => item.type === "user_message",
      ).length;
    const before = await users();
    const replies = window.locator("[data-bcselection]").filter({ hasText: "BTW_REPLY CONTEXT_A" });
    const repliesBeforeSend = await replies.count();
    await window.getByTestId("btw-send").click();
    await expect(window.getByTestId("user-message").filter({ hasText: "42ms" })).toBeVisible();
    await expect(replies).toHaveCount(repliesBeforeSend + 1);
    await expect(window.getByTestId("btw-stop")).toHaveCount(0);
    await expect(composer).toHaveValue("");
    expect(await users()).toBe(before);
    await captureBtw(page, info, "04-sent-btw-quote");
    await selectText(
      window.locator("[data-bcselection]").filter({ hasText: "BTW_REPLY CONTEXT_A" }).last(),
      "BTW_REPLY CONTEXT_A",
    );
    await expectButtons(page, btwButtons);
    await pressBar(page, "Add to BTW", "Added");
    await expectDraftFocus(composer, "> BTW_REPLY CONTEXT_A\n\n");
    await composer.fill("");
    await selectText(prose, "PARENT_RICH_PROSE");
    await pressBar(page, "Copy", "Copied");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("PARENT_RICH_PROSE");
    await expect(page.locator("[data-composer-input]:visible")).toHaveValue("");
    await expect(composer).toHaveValue("");
    await selectText(prose, "PARENT_RICH_PROSE");
    await pressBar(page, "Add to chat", "Added");
    await expect(page.locator("[data-composer-input]:visible")).toHaveValue(
      "> PARENT_RICH_PROSE\n\n",
    );
    await expect(composer).toHaveValue("");
    await page.locator("[data-composer-input]:visible").fill("");
    await prose.evaluate((element) => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 0);
      range.setEndAfter(
        document.querySelector('[data-testid="workspace-header"]') ?? document.body.lastChild!,
      );
      const selection = globalThis.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await expect(page.locator("[data-bcselectionbar]")).toBeHidden();

    await composer.fill("AFTER_B held");
    transport.holdNextClientRequest("send_agent_message_request");
    await window.getByTestId("btw-send").click();
    await transport.waitForHeldClientRequest();
    const clipboardPermission = await page.context().newCDPSession(page);
    const origin = new URL(page.url()).origin;
    const { targetInfo } = await clipboardPermission.send("Target.getTargetInfo");
    for (const allowWithoutSanitization of [false, true]) {
      await clipboardPermission.send("Browser.setPermission", {
        permission: { name: "clipboard-write", allowWithoutSanitization },
        setting: "denied",
        origin,
        browserContextId: targetInfo.browserContextId,
      });
    }
    const permissionState = await page.evaluate(
      async () =>
        (await navigator.permissions.query({ name: "clipboard-write" as PermissionName })).state,
    );
    expect(permissionState).toBe("denied");
    await info.attach("clipboard-permission-denied", {
      body: JSON.stringify({ origin, state: permissionState }),
      contentType: "application/json",
    });
    await selectText(prose, "PARENT_RICH_PROSE");
    await pressBar(page, "Add to BTW", "Couldn't copy");
    const btwAction = page
      .locator("[data-bcselectionbar]")
      .getByRole("button", { name: "Add to BTW", exact: true });
    await expect(btwAction).not.toHaveAttribute("data-done");
    await expect(btwAction).toBeEnabled();
    await expect(page.locator("[data-bcselectionbar]")).toBeVisible();
    expect(await page.evaluate(() => globalThis.getSelection()?.toString())).toBe(
      "PARENT_RICH_PROSE",
    );
    await expect(composer).toHaveValue("AFTER_B held");
    await expect(page.locator("[data-composer-input]:visible")).toHaveValue("");
    await captureBtw(page, info, "04b-clipboard-denial-retry");
    await clipboardPermission.send("Browser.resetPermissions", {
      browserContextId: targetInfo.browserContextId,
    });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    expect(
      await page.evaluate(
        async () =>
          (await navigator.permissions.query({ name: "clipboard-write" as PermissionName })).state,
      ),
    ).toBe("granted");
    await clipboardPermission.detach();
    await page.evaluate(() => navigator.clipboard.writeText("CLIPBOARD_RETRY_SENTINEL"));
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "CLIPBOARD_RETRY_SENTINEL",
    );
    expect(await page.evaluate(() => globalThis.getSelection()?.toString())).toBe(
      "PARENT_RICH_PROSE",
    );
    await pressBar(page, "Add to BTW", "Copied instead");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("PARENT_RICH_PROSE");
    await cell.dblclick();
    await expect
      .poll(
        async () => {
          const bounds = await menu.boundingBox();
          const frame = await page.getByTestId("table-selection-menu-animation").boundingBox();
          return bounds !== null && frame !== null && frame.width >= Math.ceil(bounds.width) + 1;
        },
        { message: "Expected the selected-cell menu to finish expanding" },
      )
      .toBe(true);
    await menu.getByRole("button", { name: "Add to BTW", exact: true }).click();
    await expect(page.getByTestId("app-toast-message")).toHaveText("Copied instead");
    await expect(menu.getByRole("button", { name: "Add to BTW", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("42ms");
    await prose.click();
    await transport.releaseHeldClientRequest();
    await expect(window).toContainText("BTW_REPLY AFTER_B");
    await expect(composer).toHaveValue("");
    await selectText(prose, "PARENT_RICH_PROSE");
    await pressBar(page, "Add to BTW", "Added");
    await expectDraftFocus(composer, "> PARENT_RICH_PROSE\n\n");
    await composer.fill("");
    await askBtw(page, "FAIL_BTW");
    await expect(window.getByTestId("btw-provider-error")).toBeVisible({ timeout: 60000 });
    await expect(composer).toHaveValue("FAIL_BTW");
    await selectText(prose, "PARENT_RICH_PROSE");
    await pressBar(page, "Add to BTW", "Added");
    await expectDraftFocus(composer, "FAIL_BTW\n\n> PARENT_RICH_PROSE\n\n");
    // Failed questions remain visible until a successful retry reconciles.
    await askBtw(page, "AFTER_B retry");
    await expect(window).toContainText("AFTER_B retry");
    await expect(composer).toHaveValue("");
    await expect(window.getByTestId("btw-provider-error")).toHaveCount(0);
    await expect(window.getByTestId("btw-stop")).toHaveCount(0);
    await askBtw(page, "HOLD_BTW");
    await expect.poll(() => btwRuntime.stub!.pending("btw")).toBe(1);
    await expect(composer).toHaveValue("");
    await selectText(prose, "PARENT_RICH_PROSE");
    await pressBar(page, "Add to BTW", "Added");
    btwRuntime.stub!.release("btw");
    await expect(window.getByTestId("btw-stop")).toHaveCount(0);
    await expect(composer).toHaveValue("> PARENT_RICH_PROSE\n\n");
    await window.getByTestId("btw-send").click();
    await expect(composer).toHaveValue("");
    await expect(window.getByTestId("btw-stop")).toHaveCount(0);
    const firstId = await window.getAttribute("aria-label");
    await window.getByTestId("btw-new").click();
    await expect(window).not.toHaveAttribute("aria-label", firstId!);
    await expect(composer).toHaveValue("");
    await window.getByTestId("btw-minimize").click();
    await selectText(prose, "PARENT_RICH_PROSE");
    await pressBar(page, "Add to BTW", "Added");
    await expectDraftFocus(composer, "> PARENT_RICH_PROSE\n\n");
    await window.getByTestId("btw-clear").click();
    await expect(page.getByTestId("btw-chip")).toHaveCount(0);
    await selectText(prose, "PARENT_RICH_PROSE");
    await expectButtons(page, basicButtons);

    await createThread(page, btwRuntime, a, "PANE_A");
    const agentA = new URL(page.url());
    agentA.searchParams.set("open", `agent:${a.agentId}`);
    const agentAUrl = agentA.toString();
    await runWorkspaceActionFromCommandCenter(page, "Split pane right");
    // The fresh split is a draft pane and cannot advertise a BTW target.
    const panes = page.locator('[data-testid^="workspace-pane-"]').filter({ visible: true });
    await expect(panes).toHaveCount(2);
    await expect(page.locator("[data-btw-thread]")).toHaveCount(1);
    await expect(panes.filter({ hasNot: page.locator("[data-btw-thread]") })).toHaveCount(1);
    await captureBtw(page, info, "07-draft-pane-no-target");
    const createdB = await a.client.createAgent({
      provider: "pi",
      model: btwRuntime.model,
      thinkingOptionId: "medium",
      cwd: a.cwd,
      workspaceId: a.workspaceId,
      title: "Selection sibling B",
    });
    const b = { ...a, agentId: createdB.id };
    const siblingUrl = new URL(agentAUrl);
    siblingUrl.searchParams.set("open", `agent:${b.agentId}`);
    await page.goto(siblingUrl.toString());
    await expect(
      page.getByTestId(`workspace-tab-agent_${b.agentId}`).filter({ visible: true }),
    ).toHaveAttribute("aria-selected", "true");
    const paneB = page.locator('[data-testid^="workspace-pane-"]').filter({
      has: page.getByTestId(`workspace-tab-agent_${b.agentId}`),
    });
    await expect(paneB).toHaveCount(1);
    await expect(paneB.locator("[data-btw-thread]")).toHaveCount(0);
    await paneB.getByRole("textbox", { name: "Message agent...", exact: true }).fill("PARENT_A");
    await paneB.getByRole("button", { name: "Send message", exact: true }).click();
    const replyB = paneB
      .locator("[data-bcselection]")
      .filter({ hasText: "PARENT_A_FINISHED" })
      .last();
    await expect(replyB).toBeVisible({ timeout: 60000 });
    await selectText(replyB, "PARENT_A_FINISHED");
    await expectButtons(page, basicButtons);
    await createThread(page, btwRuntime, b, "PANE_B", paneB);
    await expect(page.locator("[data-btw-thread]")).toHaveCount(2);
    await selectText(richProse(page), "PARENT_RICH_PROSE");
    await pressBar(page, "Add to BTW", "Added");
    await expectDraftFocus(
      activeWindow(page).getByTestId("btw-composer"),
      "> PARENT_RICH_PROSE\n\n",
    );
    await captureBtw(page, info, "08-split-pane-focused-insert");
    await replyB.click();
    await expect(activeWindow(page).getByTestId("btw-composer")).toHaveValue("");
    await client.archiveAgent(b.agentId);
    await expect(
      page.getByTestId(`workspace-tab-agent_${b.agentId}`).filter({ visible: true }),
    ).toHaveCount(0);
    await openSessions(page);
    await clickSessionRow(page, "Selection sibling B");
    await expectArchivedAgentFocused(page, b.agentId);
    await expect(page.locator("[data-btw-thread]")).toHaveCount(1);
    await expect(paneB.locator("[data-composer-input]:visible")).toHaveCount(0);
    await selectText(replyB, "PARENT_A_FINISHED");
    await expectButtons(page, basicButtons);
    await captureBtw(page, info, "09-archived-pane-no-chip");
    await page.getByTestId(`workspace-tab-agent_${a.agentId}`).filter({ visible: true }).click();
    await expect(richProse(page)).toBeVisible();
    const page2 = await page.context().newPage();
    try {
      await page2.goto(agentAUrl);
      await expect(activeWindow(page2).getByTestId("btw-composer")).toHaveValue("");
      await page.bringToFront();
      await activeWindow(page).getByTestId("btw-composer").fill("");
      await selectText(richProse(page), "PARENT_RICH_PROSE");
      await pressBar(page, "Add to BTW", "Added");
      await expectDraftFocus(
        activeWindow(page).getByTestId("btw-composer"),
        "> PARENT_RICH_PROSE\n\n",
      );
      await expect(activeWindow(page2).getByTestId("btw-composer")).toHaveValue("");
      await captureBtw(page, info, "10-source-page-local-draft");
      await captureBtw(page2, info, "11-second-page-empty-draft");
    } finally {
      await page2.close();
    }
  } finally {
    transport.restore();
    for (const handle of handles) await closeAgent(handle);
    await client.removePlugin("better-paseo");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
  }
});

test("journey 2: real plugin compact sheet focus and portal boundary", async ({
  page,
  btwRuntime,
}, info) => {
  test.setTimeout(240000);
  await page.setViewportSize({ width: 390, height: 844 });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "btw-real-compact" });
  const previous = await client.getDaemonConfig();
  let handle: Awaited<ReturnType<typeof launchBtwAgent>> | undefined;
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDir);
    handle = await launchBtwAgent(page, btwRuntime);
    await submitMessageWithButton(page, "PARENT_A");
    await expect(parentReply(page)).toBeVisible({ timeout: 60000 });
    await selectText(parentReply(page), "PARENT_A_FINISHED");
    await expectButtons(page, basicButtons);
    await createThread(page, btwRuntime, handle, "COMPACT_Q");
    await page.getByTestId("btw-sheet-chip").filter({ visible: true }).click();
    await expect(page.getByTestId("btw-window")).toHaveCount(0);
    await selectText(parentReply(page), "PARENT_A_FINISHED");
    await expectButtons(page, btwButtons);
    await pressBar(page, "Add to BTW", "Added");
    await expectDraftFocus(
      activeWindow(page).getByTestId("btw-composer"),
      "> PARENT_A_FINISHED\n\n",
    );
    await captureBtw(page, info, "05-compact-sheet-added");
    await page.getByTestId("btw-sheet-chip").filter({ visible: true }).click();
    await expect(page.getByTestId("btw-window")).toHaveCount(0);
    await page.getByTestId("btw-chip").filter({ visible: true }).click();
    await expect(activeWindow(page)).toBeVisible();
    await waitForSettledPosition(activeWindow(page));
    await expect(activeWindow(page).getByTestId("btw-composer")).not.toBeFocused();
    await selectText(
      activeWindow(page)
        .locator("[data-bcselection]")
        .filter({ hasText: "BTW_REPLY CONTEXT_A" })
        .last(),
      "BTW_REPLY CONTEXT_A",
    );
    await expectButtons(page, basicButtons);
  } finally {
    if (handle) await closeAgent(handle);
    await client.removePlugin("better-paseo");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
  }
});

const absentTest = btwBrowserTest(false, false);
absentTest("journey 3: real plugin without BTW extension", async ({ page, btwRuntime }, info) => {
  absentTest.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "btw-real-absent" });
  const previous = await client.getDaemonConfig();
  let handle: Awaited<ReturnType<typeof launchBtwAgent>> | undefined;
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDir);
    handle = await launchBtwAgent(page, btwRuntime);
    await submitMessageWithButton(page, "/btw no extension");
    await expect(parentReply(page)).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId("btw-chip")).toHaveCount(0);
    await selectText(parentReply(page), "PARENT_A_FINISHED");
    await expectButtons(page, basicButtons);
    await captureBtw(page, info, "06-absent-extension-no-chip");
  } finally {
    if (handle) await closeAgent(handle);
    await client.removePlugin("better-paseo");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
  }
});
