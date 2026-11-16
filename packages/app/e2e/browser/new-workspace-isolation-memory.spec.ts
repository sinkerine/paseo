import { expectStableHeight } from "../support/helpers/settled";
import { seedWorkspace } from "../support/helpers/seed-client";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";
import {
  openAddProjectFlow,
  chooseAddProjectMethod,
  addProjectFlowInput,
} from "../support/helpers/add-project-flow";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  archiveLocalWorkspaceFromDaemon,
  archiveWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  expectWorkspaceIsolationSelected,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  openStartingRefPicker,
  selectBranchInPicker,
  selectNewWorkspaceProject,
  openGlobalNewWorkspaceComposer,
  selectWorkspaceIsolation,
  submitNewWorkspaceEmpty,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { expectNoTruncation } from "../support/helpers/no-truncation";
import { createTempGitRepo } from "../support/helpers/workspace";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// Regression for "the local / worktree selection in the new workspace is not
// remembered." The isolation choice persists in the create-form preferences
// (FormPreferences.isolation), so it must survive the create→reopen remount:
// creating a worktree workspace navigates away from /new and unmounts it, and
// reopening New Workspace has to still show "New worktree".
test.describe("New workspace isolation memory", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  const localWorkspaceIds = new Set<string>();
  const createdWorktreeDirectories = new Set<string>();

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    if (client) {
      for (const workspaceDirectory of createdWorktreeDirectories) {
        await archiveWorkspaceFromDaemon(client, workspaceDirectory).catch(() => undefined);
      }
      for (const workspaceId of localWorkspaceIds) {
        await archiveLocalWorkspaceFromDaemon(client, workspaceId).catch(() => undefined);
      }
    }
    createdWorktreeDirectories.clear();
    localWorkspaceIds.clear();
    await client?.close().catch(() => undefined);
  });

  test("remembers the worktree isolation choice after creating a workspace", async ({ page }) => {
    const serverId = getServerId();
    const tempRepo = await createTempGitRepo("isolation-memory-", { branches: ["main", "dev"] });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      // First visit defaults to New worktree; explicit selections still work.
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await expectWorkspaceIsolationSelected(page, "worktree");
      await selectWorkspaceIsolation(page, "local");
      await expectWorkspaceIsolationSelected(page, "local");
      await page.getByTestId("workspace-create-isolation-trigger").click();
      const isolationPopup = page.getByTestId("combobox-desktop-container").last();
      await expect(isolationPopup).toBeVisible({ timeout: 30_000 });
      await expectNoTruncation(isolationPopup);
      await page.getByTestId("workspace-create-isolation-worktree").click();
      await expectWorkspaceIsolationSelected(page, "worktree");

      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "dev");

      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      // Second visit (fresh mount of /new): the worktree choice must stick.
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await expectWorkspaceIsolationSelected(page, "worktree");
    } finally {
      await tempRepo.cleanup();
    }
  });
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`project defaults and discarded overrides across entries and submits at ${viewport.width}px`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const alpha = await seedWorkspace({ repoPrefix: "isolation-alpha-" });
    const beta = await seedWorkspace({ repoPrefix: "isolation-beta-" });
    const gamma = await seedWorkspace({ repoPrefix: "isolation-gamma-" });
    const notes = await seedWorkspace({ repoPrefix: "isolation-notes-", git: false });
    const select = async (project: typeof alpha) => selectNewWorkspaceProject(page, project);
    try {
      await alpha.client.setProjectIsolation(alpha.projectId, "worktree");
      await beta.client.setProjectIsolation(beta.projectId, "local");
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      // Keep the sidebar available for its real entry paths, then verify compact controls.
      await openNewWorkspaceComposer(page, gamma);
      await selectWorkspaceIsolation(page, "local");
      await select(alpha);
      await page.setViewportSize(viewport);
      await expectWorkspaceIsolationSelected(page, "worktree");
      await selectWorkspaceIsolation(page, "local");
      await select(beta);
      await expectWorkspaceIsolationSelected(page, "local");
      await select(alpha);
      await expectWorkspaceIsolationSelected(page, "worktree");
      await select(gamma);
      await expectWorkspaceIsolationSelected(page, "local");
      await selectWorkspaceIsolation(page, "worktree");
      await select(alpha);
      await selectWorkspaceIsolation(page, "local");
      await submitNewWorkspaceEmpty(page);
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      const overrideId = decodeURIComponent(
        new URL(page.url()).pathname.split("/workspace/")[1]!.split("/")[0]!,
      );
      expect(
        (await alpha.client.fetchWorkspaces()).entries.find(
          (workspace) => workspace.id === overrideId,
        ),
      ).toMatchObject({ workspaceKind: "local_checkout", workspaceDirectory: alpha.repoPath });
      await page.setViewportSize({ width: 1280, height: 720 });
      await openNewWorkspaceComposer(page, alpha);
      await expectWorkspaceIsolationSelected(page, "worktree");
      await select(gamma);
      await expectWorkspaceIsolationSelected(page, "worktree");
      await select(beta);
      await expectWorkspaceIsolationSelected(page, "local");
      await submitNewWorkspaceEmpty(page);
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      const localId = decodeURIComponent(
        new URL(page.url()).pathname.split("/workspace/")[1]!.split("/")[0]!,
      );
      expect(
        (await beta.client.fetchWorkspaces()).entries.find((workspace) => workspace.id === localId),
      ).toMatchObject({ workspaceKind: "local_checkout", workspaceDirectory: beta.repoPath });
      await openNewWorkspaceComposer(page, beta);
      await selectWorkspaceIsolation(page, "worktree");
      await select(alpha);
      await select(beta);
      await expectWorkspaceIsolationSelected(page, "local");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId("compact-shell")).toBeVisible();
      await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
      const composer = page.locator('[data-testid="message-input-root"]:visible').last();
      await expectStableHeight(composer, { durationMs: 500 });
      const beforeNotes = await composer.boundingBox();
      await select(notes);
      await expect(page.getByTestId("workspace-create-isolation-trigger")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
      await expectStableHeight(composer, { durationMs: 500 });
      const afterNotes = await composer.boundingBox();
      if (!beforeNotes || !afterNotes) throw new Error("Compact composer geometry unavailable");
      expect(Math.abs(afterNotes.y - beforeNotes.y)).toBeLessThanOrEqual(1);
      await page.setViewportSize({ width: 1280, height: 720 });
      await select(alpha);
      await submitNewWorkspaceEmpty(page);
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      const workspaces = await alpha.client.fetchWorkspaces({
        filter: { projectId: alpha.projectId },
      });
      expect(
        workspaces.entries.some((workspace) => workspace.workspaceDirectory !== alpha.repoPath),
      ).toBe(true);
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: alpha.workspaceId,
      });
      await openGlobalNewWorkspaceComposer(page);
      await expectWorkspaceIsolationSelected(page, "worktree");
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: alpha.workspaceId,
      });
      await page.keyboard.press("Control+k");
      const commands = page.getByTestId("command-center-panel");
      await commands.getByTestId("command-center-input").fill("New workspace");
      await commands.getByRole("button", { name: /^New workspace(?:\s|$)/ }).click();
      await expectWorkspaceIsolationSelected(page, "worktree");
      await submitNewWorkspacePrompt(page, "Test project isolation with an initial agent");
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      const chatId = decodeURIComponent(
        new URL(page.url()).pathname.split("/workspace/")[1]!.split("/")[0]!,
      );
      const chatWorkspace = (await alpha.client.fetchWorkspaces()).entries.find(
        (workspace) => workspace.id === chatId,
      );
      if (!chatWorkspace) throw new Error("Chat workspace missing");
      expect(chatWorkspace.workspaceKind).toBe("worktree");
      await expect
        .poll(async () =>
          (await alpha.client.fetchAgents()).entries
            .filter((entry) => entry.agent.workspaceId === chatId)
            .map((entry) => entry.agent.cwd),
        )
        .toEqual([chatWorkspace.workspaceDirectory]);
      await openAddProjectFlow(page);
      await chooseAddProjectMethod(page, "directory-search");
      await addProjectFlowInput(page).fill(alpha.repoPath);
      await expect(
        page
          .getByTestId("add-project-flow-results")
          .getByRole("button")
          .filter({ hasText: alpha.repoPath })
          .first(),
      ).toBeVisible();
      await page.keyboard.press("Enter");
      await expectWorkspaceIsolationSelected(page, "worktree");
      await alpha.client.archiveWorkspace(alpha.workspaceId);
      const remaining = await alpha.client.fetchWorkspaces({
        filter: { projectId: alpha.projectId },
      });
      for (const workspace of remaining.entries) await alpha.client.archiveWorkspace(workspace.id);
      await page.goto("/");
      const ghost = page
        .getByTestId(
          `sidebar-project-new-workspace-row-${projectEquivalenceViewKey(alpha.projectKey)}`,
        )
        .first();
      await expect(ghost).toBeVisible({ timeout: 30_000 });
      await ghost.click();
      await expectWorkspaceIsolationSelected(page, "worktree");
      expect(
        (await alpha.client.listProjects()).projects.find(
          (project) => project.projectId === alpha.projectId,
        )?.projectDefaultIsolation,
      ).toBe("worktree");
    } finally {
      await notes.cleanup();
      await gamma.cleanup();
      await beta.cleanup();
      await alpha.cleanup();
    }
  });
}
