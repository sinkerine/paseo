import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test as base } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { closeAgent, type AgentHandle } from "../support/helpers/rewind-flow";
import { openSubagentsTrack } from "../support/helpers/subagents";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import {
  createPiWorkflowRuntime,
  launchPiWorkflow,
  releasePiWorkflow,
  type PiWorkflowRuntime,
} from "../support/helpers/pi-workflow";

const test = base.extend<{}, { piWorkflow: PiWorkflowRuntime }>({
  piWorkflow: [
    async ({ browserName }, provide) => {
      expect(browserName).toBe("chromium");
      const runtime = await createPiWorkflowRuntime();
      try {
        await provide(runtime);
      } finally {
        await runtime.close();
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonConfig: async ({ piWorkflow }, provide) => provide(piWorkflow.daemonConfig),
  e2eDaemonEnvironment: async ({ piWorkflow }, provide) => provide(piWorkflow.environment),
});

function trackRow(page: Page, id: string): Locator {
  return page.getByTestId(`subagents-track-row-${id}`);
}

function disclosure(page: Page, id: string): Locator {
  return page.getByTestId(`subagents-track-disclosure-${id}`);
}

function visibleRows(page: Page): Locator {
  return page.locator('[data-testid^="subagents-track-row-"][role="menuitem"]');
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
}

async function runningWorkflow(client: DaemonClient, handle: AgentHandle): Promise<string> {
  let workflowId = "";
  await expect
    .poll(
      async () => {
        const { subagents } = await client.listProviderSubagents(handle.agentId);
        const workflow = subagents.find((row) => row.title === "Workflow");
        if (!workflow) return [];
        workflowId = workflow.id;
        return ["", "/group:T1", "/group:T2", "/T2.implement", "/T2.review"].map(
          (suffix) => subagents.find((row) => row.id === `${workflowId}${suffix}`)?.status,
        );
      },
      { timeout: 60_000 },
    )
    .toEqual(["running", "completed", "running", "completed", "running"]);
  return workflowId;
}

async function expectRunningTree(page: Page, workflowId: string): Promise<void> {
  await page.getByTestId("subagents-track-header").click();
  await expect(trackRow(page, workflowId)).toBeVisible();
  await expect(visibleRows(page)).toHaveText([
    /Workflow/,
    /^T1Review T1 round 1$/,
    /^T2Review T2$/,
    /^Implement T2worker$/,
    /^Review T2reviewer$/,
  ]);
  await expect(disclosure(page, workflowId)).toHaveAccessibleName("Collapse subagent");
  await expect(disclosure(page, `${workflowId}/group:T1`)).toHaveAccessibleName("Expand subagent");
  await expect(disclosure(page, `${workflowId}/group:T2`)).toHaveAccessibleName(
    "Collapse subagent",
  );
  await expect(trackRow(page, `${workflowId}/T2.review`).getByRole("progressbar")).toHaveCount(1);
  await expect(page.getByTestId("subagents-track-header")).toHaveAccessibleName("1 working");
  await expect(page.getByTestId("subagents-track-archive-finished")).toHaveCount(0);
}

async function measureRails(page: Page, workflowId: string, testInfo: TestInfo, name: string) {
  // Read the shared token without importing React Native presentation modules into Node.
  const primitives = await readFile(
    path.resolve(__dirname, "../../src/components/tree-primitives.tsx"),
    "utf8",
  );
  const token = /export const TREE_INDENT_PER_LEVEL = (\d+);/.exec(primitives);
  if (!token) throw new Error("Shared tree indentation token is missing");
  const indent = Number(token[1]);
  const ids = [workflowId, `${workflowId}/group:T2`, `${workflowId}/T2.review`];
  const rails = [];
  for (const id of ids) {
    const body = trackRow(page, id);
    const box = await body.boundingBox();
    const iconBox = await body.locator(":scope > div").first().boundingBox();
    if (!box || !iconBox) throw new Error(`Missing rendered row rail: ${id}`);
    rails.push({ id, body: box, icon: iconBox });
  }
  expect(rails[1].icon.x - rails[0].icon.x).toBeCloseTo(indent, 0);
  expect(rails[2].icon.x - rails[0].icon.x).toBeCloseTo(2 * indent, 0);
  const evidencePath = testInfo.outputPath(`${name}.json`);
  await writeFile(evidencePath, JSON.stringify({ indent, rails }, null, 2));
  await testInfo.attach(name, { path: evidencePath, contentType: "application/json" });
}

test("running workflow panes show shared child trees on wide and compact layouts", async ({
  page,
  piWorkflow,
}, testInfo) => {
  test.setTimeout(180_000);
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "pi-workflow-pane" });
  const handles: AgentHandle[] = [];
  try {
    for (const compact of [false, true]) {
      await page.setViewportSize(
        compact ? { width: 494, height: 862 } : { width: 1280, height: 900 },
      );
      const handle = await launchPiWorkflow(page, piWorkflow);
      handles.push(handle);
      const id = await runningWorkflow(client, handle);
      await page.getByTestId("subagents-track-header").filter({ visible: true }).click();
      await trackRow(page, id).filter({ visible: true }).click();
      const pane = page.getByTestId("provider-subagent-panel").filter({ visible: true });
      const tree = pane.getByTestId("provider-subagent-tree");
      await expect(tree).toBeVisible();
      await expect(pane.getByTestId("turn-working-indicator")).toHaveCount(0);
      await expect(tree.getByTestId(`subagents-track-row-${id}/T2.review`)).toBeVisible();
      await expect(pane.getByTestId("provider-subagent-pane-subtitle")).toHaveText(
        "1 of 2 groups done",
      );
      await tree.getByTestId(`subagents-track-disclosure-${id}/group:T1`).click();
      await expect(tree.getByTestId(`subagents-track-row-${id}/T1-implement`)).toBeVisible();
      await screenshot(page, testInfo, `workflow-pane-${compact ? "compact" : "wide"}`);
      await tree.getByTestId(`subagents-track-row-${id}/group:T2`).click();
      const groupPane = page
        .getByTestId("provider-subagent-panel")
        .filter({ visible: true })
        .last();
      await expect(groupPane.getByTestId("provider-subagent-tree")).toBeVisible();
      await expect(groupPane.getByTestId("turn-working-indicator")).toHaveCount(0);
      await groupPane.getByTestId(`subagents-track-row-${id}/T2.review`).click();
      const runPane = page.getByTestId("provider-subagent-panel").filter({ visible: true }).last();
      await expect(runPane.getByTestId("provider-subagent-tree")).toHaveCount(0);
      await expect(
        runPane.getByTestId("tool-call-badge").filter({ hasText: "Shell" }),
      ).toBeVisible();
      await screenshot(page, testInfo, `workflow-run-${compact ? "compact" : "wide"}`);
      await releasePiWorkflow(piWorkflow);
      await expect
        .poll(
          async () =>
            (await client.listProviderSubagents(handle.agentId)).subagents.every(
              (row) => row.status !== "running",
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
      await rm(piWorkflow.gate);
    }
  } finally {
    await releasePiWorkflow(piWorkflow);
    for (const handle of handles) await closeAgent(handle);
    await client.close();
  }
});

test("scripted Pi workflow tree discloses independently, streams child tools, settles and rebuilds", async ({
  page,
  piWorkflow,
}, testInfo) => {
  test.setTimeout(180_000);
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "pi-workflow-browser" });
  const handles: AgentHandle[] = [];
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    const handle = await launchPiWorkflow(page, piWorkflow);
    handles.push(handle);
    const workflowId = await runningWorkflow(client, handle);
    await expectRunningTree(page, workflowId);
    await measureRails(page, workflowId, testInfo, "wide-rails");
    await screenshot(page, testInfo, "pi-workflow-wide-running");

    const panel = page.getByTestId("subagents-track-header-panel");
    const t1 = `${workflowId}/group:T1`;
    await disclosure(page, t1).click();
    await expect(trackRow(page, `${workflowId}/T1-implement`)).toBeVisible();
    await expect(trackRow(page, `${workflowId}/T1-review-1`)).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("provider-subagent-panel")).toBeHidden();
    await disclosure(page, t1).click();
    await expect(trackRow(page, `${workflowId}/T1-implement`)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await openSubagentsTrack(page);
    await expect(disclosure(page, t1)).toHaveAccessibleName("Expand subagent");
    // Keep a non-default override as well, so reload proves the reset.
    await disclosure(page, t1).click();
    await page.keyboard.press("Escape");
    await openSubagentsTrack(page);
    await expect(trackRow(page, `${workflowId}/T1-implement`)).toBeVisible();

    await trackRow(page, `${workflowId}/T2.review`).click();
    await expect(panel).toBeHidden();
    const childPanel = page.getByTestId("provider-subagent-panel").filter({ visible: true });
    await expect(childPanel).toBeVisible();
    const shell = childPanel.getByTestId("tool-call-badge").filter({ hasText: "Shell" });
    await expect(shell).toBeVisible();
    await expect(shell).toContainText("PASEO_SCRIPTED_GATE");
    await expect
      .poll(async () => {
        const timeline = await client.fetchProviderSubagentTimeline(
          handle.agentId,
          `${workflowId}/T2.review`,
          { limit: 0 },
        );
        return timeline.rows.map(({ item }) => item);
      })
      .toContainEqual(
        expect.objectContaining({ type: "tool_call", name: "bash", status: "running" }),
      );
    await screenshot(page, testInfo, "pi-workflow-review-bash");
    await page.getByTestId("parent-agent-callout-open").click();
    await openSubagentsTrack(page);
    const before = await visibleRows(page).allTextContents();
    await releasePiWorkflow(piWorkflow);
    await expect
      .poll(
        async () => {
          const { subagents } = await client.listProviderSubagents(handle.agentId);
          return subagents.length === 8 && subagents.every((row) => row.status === "completed");
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect(disclosure(page, workflowId)).toHaveAccessibleName("Expand subagent");
    await expect(visibleRows(page)).toHaveText([/Workflow/]);
    await screenshot(page, testInfo, "pi-workflow-wide-completed");
    await disclosure(page, workflowId).click();
    await expect(disclosure(page, `${workflowId}/group:T2`)).toHaveAccessibleName(
      "Expand subagent",
    );
    await expect(visibleRows(page)).toHaveText([
      /Workflow/,
      /^T1Review T1 round 1$/,
      /^Implement T1worker$/,
      /^Review T1 round 1reviewer$/,
      /^T2Review T2$/,
      /^Cleanupworker$/,
    ]);
    const cleanup = trackRow(page, `${workflowId}/cleanup`);
    const groupRail = await trackRow(page, t1).locator(":scope > div").first().boundingBox();
    const cleanupRail = await cleanup.locator(":scope > div").first().boundingBox();
    if (!cleanupRail || !groupRail) throw new Error("Missing completed tree rail");
    expect(cleanupRail.x).toBe(groupRail.x);
    await disclosure(page, `${workflowId}/group:T2`).click();
    const after = await visibleRows(page).allTextContents();
    expect(after.slice(0, -1)).toEqual(
      before.map((text) => text.replace("1 of 2 groups done", "2 of 2 groups done")),
    );
    await screenshot(page, testInfo, "pi-workflow-wide-complete-expanded");

    await page.keyboard.press("Escape");
    await page.reload();
    await openSubagentsTrack(page);
    await expect(visibleRows(page)).toHaveText([/Workflow/]);
    await disclosure(page, workflowId).click();
    await expect(disclosure(page, t1)).toHaveAccessibleName("Expand subagent");
    await expect(disclosure(page, `${workflowId}/group:T2`)).toHaveAccessibleName(
      "Expand subagent",
    );
    await page.getByTestId("subagents-track-archive-finished").click();
    await expect(trackRow(page, workflowId)).toHaveCount(0);
    await expect(page.getByTestId("subagents-track-header")).toBeHidden();

    await page.setViewportSize({ width: 494, height: 862 });
    await rm(piWorkflow.gate);
    const compactHandle = await launchPiWorkflow(page, piWorkflow);
    handles.push(compactHandle);
    const compactId = await runningWorkflow(client, compactHandle);
    await expectRunningTree(page, compactId);
    await waitForSettledPosition(trackRow(page, compactId));
    await expect(trackRow(page, `${compactId}/T2.review`)).toBeInViewport();
    await measureRails(page, compactId, testInfo, "compact-rails");
    await screenshot(page, testInfo, "pi-workflow-compact-running");
    await disclosure(page, `${compactId}/group:T1`).click();
    await expect(trackRow(page, `${compactId}/T1-implement`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toBeVisible();
    await page.reload();
    await expectRunningTree(page, compactId);
    await waitForSettledPosition(trackRow(page, compactId));
    await expect(trackRow(page, `${compactId}/T2.review`)).toBeInViewport();
    await screenshot(page, testInfo, "pi-workflow-compact-reloaded");
    await releasePiWorkflow(piWorkflow);
    await expect
      .poll(
        async () =>
          (await client.listProviderSubagents(compactHandle.agentId)).subagents.every(
            (row) => row.status === "completed",
          ),
        { timeout: 60_000 },
      )
      .toBe(true);

    const evidence = {
      daemonHome: process.env.E2E_PASEO_HOME,
      daemonPort: process.env.E2E_DAEMON_PORT,
      piEnvironment: piWorkflow.environment,
      workflows: [workflowId, compactId],
      before,
      after,
    };
    await mkdir(testInfo.outputDir, { recursive: true });
    await writeFile(testInfo.outputPath("journey.json"), JSON.stringify(evidence, null, 2));
    await testInfo.attach("journey", {
      path: testInfo.outputPath("journey.json"),
      contentType: "application/json",
    });
  } finally {
    for (const handle of handles) await closeAgent(handle);
    await client.close();
  }
});
