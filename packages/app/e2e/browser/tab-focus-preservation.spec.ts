import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installDesktopRuntime } from "../../../desktop/e2e/support/runtime";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import { closeCommandCenter } from "../support/helpers/command-center";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { openSubagentsTrack } from "../support/helpers/subagents";
import { composerLocator } from "../support/helpers/composer";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";

const artifactDir = path.resolve("../../artifacts/tab-focus/browser");

async function observe(page: Page) {
  return page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const composer = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message agent..."]',
    );
    const scroll = document.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]');
    return {
      pathname: location.pathname,
      title: document.querySelector('[data-testid="workspace-header-title"]')?.textContent,
      tabs: [...document.querySelectorAll('[data-testid^="workspace-tab-"][aria-selected]')].map(
        (tab) => ({
          id: tab.getAttribute("data-testid"),
          selected: tab.getAttribute("aria-selected"),
        }),
      ),
      activeElement: {
        tag: document.activeElement?.tagName,
        testId: document.activeElement?.getAttribute("data-testid"),
        placeholder: document.activeElement?.getAttribute("placeholder"),
      },
      draft: composer?.value,
      scrollTop: scroll?.scrollTop,
    };
  });
}

test("reconciliation preserves the focused split launcher across two workspace pages", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  await mkdir(artifactDir, { recursive: true });
  const a = await seedMockAgentWorkspace({
    repoPrefix: "tab-focus-a-",
    title: "Chat A1",
    initialPrompt: Array.from({ length: 100 }, (_, i) => `Reading note ${i}`).join("\n"),
  });
  const b = await seedMockAgentWorkspace({
    repoPrefix: "tab-focus-b-",
    title: "Chat B1",
    initialPrompt: "Keep this conversation open",
  });
  const second = await context.newPage();
  try {
    for (let turn = 0; turn < 4; turn++) {
      await a.client.sendAgentMessage(
        a.agentId,
        `Reading turn ${turn}: emit 30 coalesced agent stream updates`,
      );
      await a.client.waitForFinish(a.agentId, 20_000);
    }
    await b.client.waitForFinish(b.agentId, 20_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openAgentRoute(page, a);
    await expect(
      page.getByTestId("workspace-header-title").filter({ visible: true }),
    ).toBeVisible();
    await expect(page.getByTestId(`workspace-tab-agent_${a.agentId}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await composerLocator(page).fill("Reviewing A1 notes");
    await page
      .getByTestId("agent-chat-scroll")
      .filter({ visible: true })
      .first()
      .evaluate((element) => {
        element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 250);
      });
    await openAgentRoute(second, b);
    await expect(
      second.getByTestId("workspace-header-title").filter({ visible: true }),
    ).toBeVisible();
    await composerLocator(second).fill("Typing in Window 2");
    await composerLocator(second).focus();
    const readiness = { a: await observe(page), b: await observe(second) };
    await writeFile(
      path.join(artifactDir, "p1-readiness.json"),
      JSON.stringify(readiness, null, 2),
    );
    await runWorkspaceActionFromCommandCenter(page, "Split pane right");
    const launcher = page.locator('[data-testid^="workspace-tab-tab_"][aria-selected="true"]');
    await expect(launcher).toHaveCount(1);
    const before = { a: await observe(page), b: await observe(second) };
    const created = await a.client.createAgent({
      provider: "mock",
      cwd: a.cwd,
      workspaceId: a.workspaceId,
      title: "Reconciled root",
      model: "e2e-fast-stream",
      modeId: "load-test",
    });
    await expect(page.getByTestId(`workspace-tab-agent_${created.id}`)).toBeVisible();
    const cross = await a.client.createAgent({
      provider: "mock",
      cwd: a.cwd,
      workspaceId: a.workspaceId,
      title: "Cross-workspace subagent",
      model: "e2e-fast-stream",
      modeId: "load-test",
      labels: { "paseo.parent-agent-id": b.agentId },
    });
    const terminal = await a.client.createTerminal(a.cwd, "Reconciled terminal", undefined, {
      workspaceId: a.workspaceId,
    });
    expect(terminal.error).toBeNull();
    await expect(
      page.getByTestId("workspace-pane-main").getByTestId(`workspace-tab-agent_${cross.id}`),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("workspace-pane-main")
        .getByTestId(`workspace-tab-terminal_${terminal.terminal!.id}`),
    ).toBeVisible();
    const samples = [];
    for (let i = 0; i < 15; i++) {
      samples.push({ a: await observe(page), b: await observe(second) });
      await page.waitForTimeout(100);
    }
    await writeFile(
      path.join(artifactDir, "p1-observations.json"),
      JSON.stringify({ before, created, samples }, null, 2),
    );
    await page.screenshot({ path: path.join(artifactDir, "p1-window-a.png") });
    await second.screenshot({ path: path.join(artifactDir, "p1-window-b.png") });
    await expect(
      page.getByTestId("workspace-pane-main").getByTestId(`workspace-tab-agent_${created.id}`),
    ).toBeVisible();
    await expect(launcher).toHaveCount(1);
    for (const sample of samples) {
      expect(sample.b).toEqual(before.b);
      expect(sample.a.pathname).toBe(before.a.pathname);
      expect(sample.a.draft).toBe(before.a.draft);
      expect(Math.abs((sample.a.scrollTop ?? 0) - (before.a.scrollTop ?? 0))).toBeLessThanOrEqual(
        1,
      );
    }
  } finally {
    await second.close();
    await page.goto("about:blank");
    await a.cleanup();
    await b.cleanup();
  }
});

async function emitDesktop(page: Page, eventName: string, eventPayload: unknown) {
  await page.evaluate(
    ({ event, payload }) => {
      const emit = Reflect.get(window, "__emitDesktopEvent") as (
        event: string,
        payload: unknown,
      ) => void;
      emit(event, payload);
    },
    { event: eventName, payload: eventPayload },
  );
}

async function installBridge(page: Page) {
  await installDesktopRuntime(page, {
    serverId: getServerId(),
    daemonListen: `127.0.0.1:${getE2EDaemonPort()}`,
    manageBuiltInDaemon: false,
  });
}

test("desktop deliveries preserve composer, parked focus, unseen layouts, and deliberate reveals", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await installBridge(page);
  const a = await seedMockAgentWorkspace({
    repoPrefix: "tab-focus-delivery-",
    title: "Delivery parent",
    initialPrompt: "emit 100 coalesced agent stream updates",
  });
  const unseen = await seedMockAgentWorkspace({
    repoPrefix: "tab-focus-unseen-",
    title: "Unseen root",
  });
  try {
    await a.client.waitForFinish(a.agentId, 20_000);
    const child = await a.client.createAgent({
      provider: "mock",
      model: "e2e-fast-stream",
      cwd: a.cwd,
      workspaceId: a.workspaceId,
      title: "Background child",
      labels: { "paseo.parent-agent-id": a.agentId },
    });
    const hidden = await unseen.client.createAgent({
      provider: "mock",
      model: "e2e-fast-stream",
      cwd: unseen.cwd,
      workspaceId: unseen.workspaceId,
      title: "Unseen child",
      labels: { "paseo.parent-agent-id": unseen.agentId },
    });
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, a);
    await expect(composerLocator(page)).toBeEditable();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__desktopActiveWorkspace")))
      .toEqual({ serverId: getServerId(), workspaceId: a.workspaceId });
    await composerLocator(page).fill("Keep my draft");
    await composerLocator(page).focus();
    const before = await observe(page);
    await emitDesktop(page, "open-agent", {
      serverId: getServerId(),
      agentId: child.id,
      focus: false,
    });
    await expect(page.getByTestId(`workspace-tab-agent_${child.id}`)).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(composerLocator(page)).toBeFocused();
    expect((await observe(page)).draft).toBe("Keep my draft");
    expect((await observe(page)).pathname).toBe(before.pathname);
    await page.evaluate(
      (target) => {
        const request = Reflect.get(window, "__requestDesktopAgentWorkspace") as (
          requestId: string,
          target: { serverId: string; agentId: string },
        ) => void;
        request("ownership", target);
      },
      { serverId: getServerId(), agentId: child.id },
    );
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__desktopWorkspaceReply")))
      .toEqual({ requestId: "ownership", workspaceId: a.workspaceId });
    const parkedChild = await a.client.createAgent({
      provider: "mock",
      model: "e2e-fast-stream",
      cwd: a.cwd,
      workspaceId: a.workspaceId,
      title: "Parked child",
      labels: { "paseo.parent-agent-id": a.agentId },
    });
    await composerLocator(page).focus();
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("command-center-panel")).toBeVisible();
    await emitDesktop(page, "open-agent", {
      serverId: getServerId(),
      agentId: parkedChild.id,
      focus: false,
    });
    await expect(page.getByTestId(`workspace-tab-agent_${parkedChild.id}`)).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await emitDesktop(page, "open-agent", {
      serverId: getServerId(),
      agentId: hidden.id,
      focus: false,
    });
    await expect
      .poll(() =>
        page.evaluate(
          ({ key, id }) =>
            localStorage.getItem("workspace-layout-state")?.includes(id) &&
            JSON.parse(localStorage.getItem("workspace-layout-state")!).state.layoutByWorkspace[
              key
            ] !== undefined,
          { key: `${getServerId()}:${unseen.workspaceId}`, id: hidden.id },
        ),
      )
      .toBe(true);
    await expect(page.getByTestId("command-center-panel")).toBeVisible();
    await closeCommandCenter(page);
    await expect(composerLocator(page)).toBeFocused();
    await emitDesktop(page, "open-agent", {
      serverId: getServerId(),
      agentId: "confirmed-missing-agent",
      focus: false,
    });
    await expect(composerLocator(page)).toBeFocused();
    await emitDesktop(page, "open-agent", { serverId: getServerId(), agentId: child.id });
    await expect(page.getByTestId(`workspace-tab-agent_${child.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByTestId(`workspace-tab-agent_${a.agentId}`).click();
    await openSubagentsTrack(page);
    await page.getByTestId(`subagents-track-row-${child.id}`).click();
    await expect(page.getByTestId(`workspace-tab-agent_${child.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.screenshot({ path: path.join(artifactDir, "desktop-deliveries.png") });
  } finally {
    await page.goto("about:blank");
    await a.cleanup();
    await unseen.cleanup();
  }
});

test("browser request ownership preserves active chat and supports foreground browser opens", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installBridge(page);
  const a = await seedMockAgentWorkspace({
    repoPrefix: "tab-focus-browser-",
    title: "Browser parent",
  });
  try {
    await openAgentRoute(page, a);
    await page.getByTestId("workspace-pane-main").getByTestId("workspace-new-tab-button").click();
    await page.getByTestId("workspace-new-tab-menu-browser").click();
    const browserTab = page.locator(
      '[data-testid^="workspace-tab-browser_"][aria-selected="true"]',
    );
    await expect(browserTab).toHaveCount(1);
    const browserId = (await browserTab.getAttribute("data-testid"))!.slice(
      "workspace-tab-browser_".length,
    );
    await page.getByTestId(`workspace-tab-agent_${a.agentId}`).click();
    await composerLocator(page).fill("Browser must not interrupt");
    await composerLocator(page).focus();
    await emitDesktop(page, "browser-new-tab-request", {
      sourceBrowserId: browserId,
      url: "https://example.com/unfocused",
    });
    await expect(page.locator('[data-testid^="workspace-tab-browser_"]')).toHaveCount(2);
    await expect(composerLocator(page)).toBeFocused();
    await expect(composerLocator(page)).toHaveValue("Browser must not interrupt");
    await page.getByTestId(`workspace-tab-browser_${browserId}`).click();
    await emitDesktop(page, "browser-new-tab-request", {
      sourceBrowserId: browserId,
      url: "https://example.com/background",
      background: true,
    });
    await expect(page.locator('[data-testid^="workspace-tab-browser_"]')).toHaveCount(3);
    await expect(page.getByTestId(`workspace-tab-browser_${browserId}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await emitDesktop(page, "browser-new-tab-request", {
      sourceBrowserId: browserId,
      url: "https://example.com/foreground",
    });
    await expect(page.locator('[data-testid^="workspace-tab-browser_"]')).toHaveCount(4);
    await expect(page.getByTestId(`workspace-tab-browser_${browserId}`)).toHaveAttribute(
      "aria-selected",
      "false",
    );
  } finally {
    await page.goto("about:blank");
    await a.cleanup();
  }
});

test("an empty hydrated launcher and a focused side file survive directory updates", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() =>
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ chatDisplay: "full", openInSidePane: { explorerFiles: true } }),
    ),
  );
  const workspace = await seedWorkspace({ repoPrefix: "tab-focus-empty-" });
  try {
    await writeFile(path.join(workspace.repoPath, "focus.txt"), "Keep this file selected\n");
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/h/${getServerId()}/workspace/${workspace.workspaceId}`, {
      waitUntil: "commit",
    });
    const launcher = page.locator('[data-testid^="workspace-tab-tab_"][aria-selected="true"]');
    await expect(launcher).toHaveCount(1);
    const id = await launcher.getAttribute("data-testid");
    const root = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Root after hydration",
    });
    await expect(page.getByTestId(`workspace-tab-agent_${root.id}`)).toBeVisible();
    await expect(page.getByTestId(id!)).toHaveAttribute("aria-selected", "true");
    await openFileExplorer(page);
    await openFileFromExplorer(page, "focus.txt");
    const file = page.getByTestId("workspace-tab-file_focus.txt");
    await expect(file).toHaveAttribute("aria-selected", "true");
    const filePane = page.locator('[data-testid^="workspace-pane-"]').filter({ has: file });
    await expect(filePane).not.toHaveAttribute("data-testid", "workspace-pane-main");
    await file.click();
    const selectedBefore = await observe(page);
    const terminal = await workspace.client.createTerminal(
      workspace.repoPath,
      "Side-file terminal",
      undefined,
      { workspaceId: workspace.workspaceId },
    );
    expect(terminal.error).toBeNull();
    await expect(
      page
        .getByTestId("workspace-pane-main")
        .getByTestId(`workspace-tab-terminal_${terminal.terminal!.id}`),
    ).toBeVisible();
    await expect(file).toHaveAttribute("aria-selected", "true");
    expect((await observe(page)).activeElement).toEqual(selectedBefore.activeElement);
  } finally {
    await page.goto("about:blank");
    await workspace.cleanup();
  }
});

test("independent pages preserve both workspace selections across interleaved saves and reload", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const a = await seedMockAgentWorkspace({
    repoPrefix: "tab-focus-persist-a-",
    title: "Persistence A",
  });
  const b = await seedMockAgentWorkspace({
    repoPrefix: "tab-focus-persist-b-",
    title: "Persistence B",
  });
  const second = await context.newPage();
  try {
    await openAgentRoute(page, a);
    await openAgentRoute(page, b);
    await openAgentRoute(page, a);
    await openAgentRoute(second, b);
    await expect(
      second.getByTestId("workspace-header-title").filter({ visible: true }),
    ).toBeVisible();
    await expect(second.getByTestId(`workspace-tab-agent_${b.agentId}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(composerLocator(second)).toBeEditable();
    await expect(page.getByTestId(`workspace-tab-agent_${a.agentId}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByTestId("workspace-pane-main").getByTestId("workspace-new-tab-button").click();
    await page.getByTestId("workspace-new-tab-menu-agent").click();
    const aDraft = page.locator('[data-testid^="workspace-tab-draft_"][aria-selected="true"]');
    await expect(aDraft).toHaveCount(1);
    const aId = await aDraft.getAttribute("data-testid");
    await writeFile(
      path.join(artifactDir, "persistence-after-a.json"),
      JSON.stringify(
        {
          aId,
          storage: await page.evaluate(() =>
            Object.fromEntries(
              Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
            ),
          ),
        },
        null,
        2,
      ),
    );
    await expect
      .poll(() =>
        page.evaluate((testId) => {
          const raw = localStorage.getItem("workspace-layout-state");
          return raw !== null && raw.includes(testId!.slice("workspace-tab-draft_".length));
        }, aId),
      )
      .toBe(true);
    await second.getByTestId("workspace-pane-main").getByTestId("workspace-new-tab-button").click();
    await second.getByTestId("workspace-new-tab-menu-agent").click();
    const bDraft = second.locator('[data-testid^="workspace-tab-draft_"][aria-selected="true"]');
    await expect(bDraft).toHaveCount(1);
    const bId = await bDraft.getAttribute("data-testid");
    await expect
      .poll(() =>
        second.evaluate(
          ({ firstId, secondId }) => {
            const raw = localStorage.getItem("workspace-layout-state");
            return (
              raw !== null &&
              raw.includes(firstId!.slice("workspace-tab-draft_".length)) &&
              raw.includes(secondId!.slice("workspace-tab-draft_".length))
            );
          },
          { firstId: aId, secondId: bId },
        ),
      )
      .toBe(true);
    await page.reload();
    await second.reload();
    await expect(page.getByTestId(aId!)).toHaveAttribute("aria-selected", "true");
    await expect(second.getByTestId(bId!)).toHaveAttribute("aria-selected", "true");
    await writeFile(
      path.join(artifactDir, "persistence.json"),
      JSON.stringify({ a: await observe(page), b: await observe(second) }, null, 2),
    );
  } finally {
    await second.close();
    await page.goto("about:blank");
    await a.cleanup();
    await b.cleanup();
  }
});
