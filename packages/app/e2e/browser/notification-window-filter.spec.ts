import { expect, type Page } from "@playwright/test";
import { test as base } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { createMockIdleAgent } from "../support/helpers/archive-tab";
import {
  seedWorkspace,
  connectSeedClient,
  type SeededWorkspace,
} from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  captureNotifications,
  installNotificationRecorder,
  readNotifications,
} from "../support/helpers/notification-recorder";
import {
  closeSidebarDisplayPreferences,
  openSidebarDisplayPage,
  openSidebarProjectFilter,
  selectAllProjectsFilter,
  toggleProjectFilter,
} from "../support/helpers/sidebar";
import {
  addOfflineHostAndReload,
  openSidebarHostFilter,
  toggleHostFilter,
} from "../support/helpers/hosts";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { hideDeveloperToasts } from "../support/developer-ui.mjs";

interface NotificationWorkspace extends SeededWorkspace {
  agentId: string;
}
interface NotificationScenario {
  seed(
    name: string,
    options?: { background?: boolean; port?: number },
  ): Promise<NotificationWorkspace>;
  openB(): Promise<Page>;
  capture(name: string): Promise<void>;
}
const test = base.extend<{ scenario: NotificationScenario; restartHost: IsolatedHostDaemon }>({
  scenario: async ({ page, context }, provide, testInfo) => {
    const resources: SeededWorkspace[] = [];
    let second: Page | undefined;
    await context.route(/:(6767)\b/, (route) => route.abort());
    await context.routeWebSocket(/:(6767)\b/, (socket) => socket.close());
    await installNotificationRecorder(context);
    await testInfo.attach("runtime-identity", {
      body: JSON.stringify({
        node: process.version,
        executable: process.execPath,
        browser: context.browser()?.version(),
      }),
      contentType: "application/json",
    });
    const capture = async (name: string) => {
      await captureNotifications(page, testInfo, `${name}-A`);
      if (second) await captureNotifications(second, testInfo, `${name}-B`);
    };
    try {
      await provide({
        async seed(name, options) {
          const workspace = await seedWorkspace({
            repoPrefix: `notification-${name.toLowerCase()}-`,
            title: name,
            ...options,
          });
          resources.push(workspace);
          const agent = await createMockIdleAgent(workspace.client, {
            cwd: workspace.workspaceDirectory,
            workspaceId: workspace.workspaceId,
            title: `${name} agent`,
          });
          return { ...workspace, agentId: agent.id };
        },
        async openB() {
          second = await context.newPage();
          await hideDeveloperToasts(second);
          await gotoAppShell(second);
          return second;
        },
        capture,
      });
    } finally {
      try {
        await capture("final");
      } finally {
        for (const resource of resources.toReversed()) await resource.cleanup();
      }
    }
  },
  restartHost: async ({ e2eWorker }, provide) => {
    void e2eWorker;
    const daemon = await startIsolatedHostDaemon("notification-window-filter");
    try {
      await provide(daemon);
    } finally {
      await daemon.close();
    }
  },
});

test.describe.configure({ timeout: 120_000 });
test.use({ trace: "on" });

function workspaceRow(page: Page, workspace: SeededWorkspace, serverId = getServerId()) {
  return page.getByTestId(`sidebar-workspace-row-${serverId}:${workspace.workspaceId}`);
}
async function finishAgent(workspace: NotificationWorkspace): Promise<void> {
  const running = workspace.client.waitForAgentUpsert(
    workspace.agentId,
    (agent) => agent.status === "running",
  );
  await workspace.client.sendAgentMessage(
    workspace.agentId,
    "Reply briefly to finish this notification check.",
  );
  await running;
  await workspace.client.waitForAgentUpsert(workspace.agentId, (agent) => agent.status === "idle");
}
async function waitForHostOnline(page: Page, port: number): Promise<void> {
  const socket = await page.waitForEvent("websocket", {
    predicate: (candidate) => new URL(candidate.url()).port === String(port),
  });
  await socket.waitForEvent("framereceived", {
    predicate: (frame) =>
      typeof frame.payload === "string" && frame.payload.includes('"server_info"'),
  });
}
async function counts(a: Page, b: Page, agentId: string): Promise<number[]> {
  const records = await Promise.all([readNotifications(a), readNotifications(b)]);
  return records.map(
    (notifications) => notifications.filter((record) => record.data?.agentId === agentId).length,
  );
}
async function pinProjects(page: Page, projects: NotificationWorkspace[]): Promise<void> {
  await openSidebarProjectFilter(page);
  await selectAllProjectsFilter(page);
  for (const project of projects) await toggleProjectFilter(page, project.projectKey);
  await closeSidebarDisplayPreferences(page);
}
async function expectOnlyProject(
  page: Page,
  included: SeededWorkspace,
  excluded: SeededWorkspace,
  serverId = getServerId(),
): Promise<void> {
  await expect(workspaceRow(page, included, serverId)).toBeVisible({ timeout: 30_000 });
  await expect(workspaceRow(page, excluded, serverId)).toHaveCount(0);
}

test("J0 observes exactly one elected notification across two renderers", async ({
  page,
  scenario,
}) => {
  const alpha = await scenario.seed("Alpha");
  const beta = await scenario.seed("Beta");
  await gotoAppShell(page);
  await expect(workspaceRow(page, alpha)).toBeVisible({ timeout: 30_000 });
  await expect(workspaceRow(page, beta)).toBeVisible();
  const b = await scenario.openB();
  await expect(workspaceRow(b, alpha)).toBeVisible({ timeout: 30_000 });
  await expect(workspaceRow(b, beta)).toBeVisible();
  await finishAgent(alpha);
  await expect
    .poll(async () => (await counts(page, b, alpha.agentId)).reduce((sum, count) => sum + count, 0))
    .toBe(1);
});

test("J1 routes to the window whose project filter includes the agent", async ({
  page,
  scenario,
}) => {
  const alpha = await scenario.seed("Alpha");
  const beta = await scenario.seed("Beta");
  await gotoAppShell(page);
  await expect(workspaceRow(page, beta)).toBeVisible({ timeout: 30_000 });
  await pinProjects(page, [alpha]);
  await expectOnlyProject(page, alpha, beta);
  const b = await scenario.openB();
  await expectOnlyProject(b, alpha, beta);
  await pinProjects(b, [beta]);
  await expectOnlyProject(b, beta, alpha);
  await expectOnlyProject(page, alpha, beta);
  await scenario.capture("independent-filters");
  await finishAgent(alpha);
  await expect
    .poll(() => counts(page, b, alpha.agentId), { message: "A received Alpha; B excluded Alpha" })
    .toEqual([1, 0]);
  await scenario.capture("first-Alpha");
  await b.reload();
  await expectOnlyProject(b, beta, alpha);
  await finishAgent(beta);
  await expect
    .poll(() => counts(page, b, beta.agentId), {
      message: "B received Beta after reload and hydration",
    })
    .toEqual([0, 1]);
  await scenario.capture("reloaded-Beta-owner");
  await finishAgent(alpha);
  await expect.poll(() => counts(page, b, alpha.agentId)).toEqual([2, 0]);
  await scenario.capture("reloaded-Beta");
  await openSidebarProjectFilter(b);
  await selectAllProjectsFilter(b);
  await closeSidebarDisplayPreferences(b);
  await expect(workspaceRow(b, alpha)).toBeVisible();
  await finishAgent(alpha);
  await expect
    .poll(() => counts(page, b, alpha.agentId), {
      message: "B received Alpha after choosing All projects",
    })
    .toEqual([2, 1]);
  await scenario.capture("all-projects");
});

test("J2 keeps overlapping matching windows on the existing recency rule", async ({
  page,
  scenario,
}) => {
  const alpha = await scenario.seed("Alpha");
  const beta = await scenario.seed("Beta");
  await gotoAppShell(page);
  await expect(workspaceRow(page, beta)).toBeVisible({ timeout: 30_000 });
  await pinProjects(page, [alpha]);
  await expectOnlyProject(page, alpha, beta);
  const b = await scenario.openB();
  await expectOnlyProject(b, alpha, beta);
  await openSidebarProjectFilter(b);
  await selectAllProjectsFilter(b);
  await closeSidebarDisplayPreferences(b);
  await expect(workspaceRow(b, beta)).toBeVisible();
  await finishAgent(alpha);
  await expect.poll(() => counts(page, b, alpha.agentId)).toEqual([0, 1]);
});

test("J3 excludes a window whose host filter omits the host", async ({ page, scenario }) => {
  const alpha = await scenario.seed("Alpha");
  await scenario.seed("Beta");
  await gotoAppShell(page);
  await addOfflineHostAndReload(page, {
    serverId: "notification-secondary",
    label: "Secondary Host",
  });
  await expect(workspaceRow(page, alpha)).toBeVisible({ timeout: 30_000 });
  const b = await scenario.openB();
  await expect(workspaceRow(b, alpha)).toBeVisible({ timeout: 30_000 });
  await openSidebarHostFilter(b);
  await toggleHostFilter(b, "notification-secondary");
  await closeSidebarDisplayPreferences(b);
  await expect(workspaceRow(b, alpha)).toHaveCount(0);
  await scenario.capture("excluded-host");
  await finishAgent(alpha);
  await expect
    .poll(() => counts(page, b, alpha.agentId), {
      message: "A received primary host Alpha; B excluded host",
    })
    .toEqual([1, 0]);
});

test("J4 drops a notification no present window's filter includes", async ({ page, scenario }) => {
  const alpha = await scenario.seed("Alpha");
  const beta = await scenario.seed("Beta");
  const gamma = await scenario.seed("Gamma");
  await gotoAppShell(page);
  await expect(workspaceRow(page, gamma)).toBeVisible({ timeout: 30_000 });
  await pinProjects(page, [alpha]);
  await expectOnlyProject(page, alpha, beta);
  const b = await scenario.openB();
  await expectOnlyProject(b, alpha, beta);
  await pinProjects(b, [beta]);
  await expectOnlyProject(b, beta, alpha);
  await expect(workspaceRow(page, gamma)).toHaveCount(0);
  await expect(workspaceRow(b, gamma)).toHaveCount(0);
  await scenario.capture("no-match");
  await finishAgent(gamma);
  await finishAgent(alpha);
  await expect
    .poll(() => counts(page, b, alpha.agentId), { message: "A received the in-scope fence" })
    .toEqual([1, 0]);
  expect(await counts(page, b, gamma.agentId)).toEqual([0, 0]);
  expect([...(await readNotifications(page)), ...(await readNotifications(b))]).toHaveLength(1);
});

test("J5 presentation filters do not remove ownership", async ({ page, scenario }) => {
  const alpha = await scenario.seed("Alpha");
  const beta = await scenario.seed("Beta");
  const background = await scenario.seed("BgProj", { background: true });
  await beta.client.setWorkspaceLabel({
    workspaceId: beta.workspaceId,
    label: { name: "Focus", color: "red" },
    assigned: true,
  });
  await gotoAppShell(page);
  await expect(workspaceRow(page, beta)).toBeVisible({ timeout: 30_000 });
  await pinProjects(page, [alpha, background]);
  await expect(workspaceRow(page, alpha)).toBeVisible();
  await expect(workspaceRow(page, background)).toHaveCount(0);
  await openSidebarDisplayPage(page, "sidebar-display-label-filter");
  await page.getByTestId("sidebar-label-filter-option-Focus").click();
  await closeSidebarDisplayPreferences(page);
  await expect(workspaceRow(page, alpha)).toHaveCount(0);
  await expect(workspaceRow(page, background)).toHaveCount(0);
  const b = await scenario.openB();
  await expect(b.getByTestId("sidebar-display-preferences-menu")).toBeVisible({ timeout: 30_000 });
  await openSidebarDisplayPage(b, "sidebar-display-label-filter");
  await b.getByTestId("sidebar-label-filter-clear").click();
  await closeSidebarDisplayPreferences(b);
  await pinProjects(b, [beta]);
  await expectOnlyProject(b, beta, alpha);
  await scenario.capture("presentation-hidden");
  await finishAgent(alpha);
  await expect
    .poll(() => counts(page, b, alpha.agentId), {
      message: "A received Alpha despite label filter",
    })
    .toEqual([1, 0]);
  await scenario.capture("Alpha-label-owner");
  await finishAgent(background);
  await expect
    .poll(() => counts(page, b, background.agentId), {
      message: "A received BgProj despite Show background off",
    })
    .toEqual([1, 0]);
});

test("J6 restores window scopes after the daemon restarts", async ({
  page,
  restartHost,
  scenario,
}) => {
  const alpha = await scenario.seed("Alpha", { port: restartHost.port });
  const beta = await scenario.seed("Beta", { port: restartHost.port });
  await seedSavedSettingsHosts(page, [
    {
      serverId: restartHost.serverId,
      label: "Notification QA",
      endpoint: `127.0.0.1:${restartHost.port}`,
    },
  ]);
  await gotoAppShell(page);
  await expect(workspaceRow(page, beta, restartHost.serverId)).toBeVisible({ timeout: 30_000 });
  await pinProjects(page, [alpha]);
  await expectOnlyProject(page, alpha, beta, restartHost.serverId);
  const b = await scenario.openB();
  await expectOnlyProject(b, alpha, beta, restartHost.serverId);
  await pinProjects(b, [beta]);
  await expectOnlyProject(b, beta, alpha, restartHost.serverId);
  const aSocket = waitForHostOnline(page, restartHost.port);
  const bSocket = waitForHostOnline(b, restartHost.port);
  await restartHost.restart();
  await Promise.all([aSocket, bSocket]);
  await expectOnlyProject(page, alpha, beta, restartHost.serverId);
  await expectOnlyProject(b, beta, alpha, restartHost.serverId);
  await scenario.capture("reconnected");
  const client = await connectSeedClient({ port: restartHost.port });
  try {
    const agent = await createMockIdleAgent(client, {
      cwd: alpha.workspaceDirectory,
      workspaceId: alpha.workspaceId,
      title: "After restart",
    });
    await finishAgent({ ...alpha, client, agentId: agent.id });
    await expect
      .poll(() => counts(page, b, agent.id), {
        message: "A received Alpha from replayed reconnect scope",
      })
      .toEqual([1, 0]);
  } finally {
    await client.close();
  }
});
