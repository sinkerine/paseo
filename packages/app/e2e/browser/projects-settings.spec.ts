import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as base, type Page } from "../support/fixtures";
import { connectSeedClient, seedWorkspace } from "../support/helpers/seed-client";
import {
  holdProjectIsolationSave,
  blockPaseoConfigWrites,
  bumpPaseoConfigOnDisk,
  chooseProjectIconImage,
  clickReloadProjectSettings,
  clickRetryProjectSettingsSave,
  clickSaveProjectSettings,
  commitPaseoConfig,
  corruptPaseoConfig,
  editWorktreeSetup,
  expectEmptyScriptList,
  expectProjectHostContextHidden,
  expectNoEditableTarget,
  expectNoProjectSettingsError,
  expectNoUncommittedSetupWarning,
  expectProjectEditFailed,
  expectProjectEditName,
  expectProjectEditSaved,
  expectProjectEditsSaveDisabled,
  expectProjectSettingsError,
  expectProjectSettingsFormHidden,
  expectProjectSettingsFormVisible,
  expectProjectTitle,
  expectProjectSettingsHistoryRoundTrip,
  expectSaveButtonDisabled,
  expectScriptRowCount,
  expectWriteFailedCalloutActions,
  expectUncommittedSetupWarning,
  fillProjectIconUrl,
  fillProjectName,
  installDaemonConnectionGate,
  installReadTransportFailure,
  navigateToProjectSettings,
  openProjectEditSheet,
  openProjectSettings,
  openProjects,
  removeProjectScript,
  restorePaseoConfig,
  returnToProjectsList,
  saveProjectEdits,
  unblockPaseoConfigWrites,
} from "../support/helpers/project-settings";
import { gotoAppShell } from "../support/helpers/app";
import { openCompactSettings } from "../support/helpers/settings";
import {
  addProjectFlowInput,
  chooseAddProjectMethod,
  openAddProjectFlow,
} from "../support/helpers/add-project-flow";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  buildProjectSettingsRoute,
  buildOpenProjectRoute,
  buildProjectsSettingsRoute,
  buildSettingsRoute,
} from "@/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";

const updatedSetup = ["npm install", "npm run build"];

// Smallest valid square PNG the daemon will accept as a custom project icon.
const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
]);

interface ProjectsSettingsProject {
  name: string;
  path: string;
}

interface ProjectsSettingsFixtures {
  editableProject: ProjectsSettingsProject;
  gitlabRemoteProject: ProjectsSettingsProject;
}

const initialPaseoConfig = {
  worktree: {
    setup: ["echo initial setup"],
    teardown: "echo cleanup",
    customWorktreeField: "preserved",
  },
  scripts: {
    dev: {
      command: "npm run dev",
      type: "server",
      port: 3000,
      customScriptField: "preserved",
    },
  },
  customTopLevelField: "preserved",
};

const test = base.extend<ProjectsSettingsFixtures>({
  editableProject: async ({ page: _page }, provide) => {
    const workspace = await seedWorkspace({
      repoPrefix: "projects-settings-",
      repo: { paseoConfig: initialPaseoConfig },
    });

    await provide({
      name: workspace.projectDisplayName,
      path: workspace.repoPath,
    });

    // Defensive: restore directory write permission in case the test left it blocked
    // (write_failed test), so that cleanup can remove files inside.
    await chmod(workspace.repoPath, 0o755).catch(() => undefined);
    await workspace.cleanup();
  },
  gitlabRemoteProject: async ({ page: _page }, provide) => {
    const workspace = await seedWorkspace({
      repoPrefix: "projects-settings-gitlab-",
      repo: {
        paseoConfig: initialPaseoConfig,
        originUrl: "https://gitlab.com/acme/app.git",
      },
    });

    await provide({
      name: workspace.projectDisplayName,
      path: workspace.repoPath,
    });

    await workspace.cleanup();
  },
});

async function expectProjectConfigSaved(project: ProjectsSettingsProject): Promise<void> {
  await expect
    .poll(
      async () => {
        const contents = await readProjectConfigFile(project);
        return JSON.parse(contents) as unknown;
      },
      {
        timeout: 30_000,
      },
    )
    .toMatchObject({
      worktree: {
        setup: updatedSetup,
        teardown: initialPaseoConfig.worktree.teardown,
        customWorktreeField: initialPaseoConfig.worktree.customWorktreeField,
      },
      scripts: {
        dev: {
          command: initialPaseoConfig.scripts.dev.command,
          type: initialPaseoConfig.scripts.dev.type,
          port: initialPaseoConfig.scripts.dev.port,
          customScriptField: initialPaseoConfig.scripts.dev.customScriptField,
        },
      },
      customTopLevelField: initialPaseoConfig.customTopLevelField,
    });

  const savedConfig = await readProjectConfigFile(project);
  expect(savedConfig).toBe(`${JSON.stringify(JSON.parse(savedConfig), null, 2)}\n`);
}

async function readProjectConfigFile(project: ProjectsSettingsProject): Promise<string> {
  return readFile(path.join(project.path, "paseo.json"), "utf8");
}

async function addProjectFromSidebar(page: Page, projectPath: string): Promise<string> {
  await openAddProjectFlow(page);
  await chooseAddProjectMethod(page, "directory-search");

  const input = addProjectFlowInput(page);
  await input.fill(projectPath);
  await page.keyboard.press("Enter");

  const projectRow = page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ hasText: path.basename(projectPath) })
    .first();
  await expect(projectRow).toBeVisible({ timeout: 30_000 });

  const testId = await projectRow.getAttribute("data-testid");
  expect(testId).not.toBeNull();
  return testId!.replace("sidebar-project-row-", "");
}

async function openProjectSettingsFromSidebar(page: Page, projectId: string): Promise<void> {
  const projectRow = page.getByTestId(`sidebar-project-row-${projectId}`);
  await expect(projectRow).toBeVisible({ timeout: 30_000 });
  await projectRow.hover();

  const kebab = page.getByTestId(`sidebar-project-kebab-${projectId}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  const openSettingsItem = page.getByTestId(`sidebar-project-menu-open-settings-${projectId}`);
  await expect(openSettingsItem).toBeVisible({ timeout: 10_000 });
  await openSettingsItem.click();
}

async function switchProjectSettingsTarget(
  page: Page,
  projectId: string,
  name: string,
): Promise<void> {
  const originalDocument = await page.locator("html").elementHandle();
  await page.evaluate(
    (route) => {
      window.history.pushState(null, "", route);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    buildProjectSettingsRoute(getServerId(), projectId),
  );
  await expectProjectTitle(page, name);
  expect(await originalDocument!.evaluate((element) => element.isConnected)).toBe(true);
  await originalDocument!.dispose();
}

test.describe("Projects settings", () => {
  test("hides isolation for non-Git projects", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "isolation-nongit-settings-", git: false });
    try {
      await openProjects(page);
      await navigateToProjectSettings(page, workspace.projectDisplayName);
      await expectProjectSettingsFormVisible(page);
      await expect(page.getByTestId("project-isolation-card")).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("project isolation stays editable with invalid paseo.json", async ({
    page,
    editableProject,
  }) => {
    await corruptPaseoConfig(editableProject.path);
    await openProjects(page);
    await navigateToProjectSettings(page, editableProject.name);
    await expect(page.getByTestId("invalid-callout")).toBeVisible();
    const row = page.getByTestId("project-isolation-row");
    await row.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Local", exact: true }).click();
    await expect(row).toContainText("Local");
    await expect(page.getByText("Workspace isolation updated", { exact: true })).toBeVisible();
    await expectNoUncommittedSetupWarning(page);
    await page.reload();
    await expect(page.getByTestId("invalid-callout")).toBeVisible();
    await expect(page.getByTestId("project-isolation-row")).toContainText("Local");
  });

  test("surfaces inline error when project isolation save fails and recovers on retry", async ({
    page,
    editableProject,
  }) => {
    const gate = await holdProjectIsolationSave(page);
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    const row = page.getByTestId("project-isolation-row");
    const trigger = row.getByRole("button");
    await expect(row).toContainText("Remember last");
    await trigger.click();
    await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
    await expect(trigger).toBeDisabled();
    gate.fail();
    await expect(row.getByRole("alert")).toHaveText("Disk full");
    await expect(trigger).toBeEnabled();
    await expect(row).toContainText("Remember last");
    gate.recover();
    await trigger.click();
    await page.getByRole("menuitem", { name: "Local", exact: true }).click();
    await expect(row.getByRole("alert")).toHaveCount(0);
    await expect(row).toContainText("Local");
    await expect(page.getByText("Workspace isolation updated", { exact: true })).toBeVisible();
  });

  test("isolation error belongs to the settings target after direct project navigation", async ({
    page,
    editableProject,
  }) => {
    const other = await seedWorkspace({ repoPrefix: "isolation-other-target-" });
    try {
      const gate = await holdProjectIsolationSave(page);
      await openProjects(page);
      await openProjectSettings(page, editableProject.name);
      const row = page.getByTestId("project-isolation-row");
      await row.getByRole("button").click();
      await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
      gate.fail();
      await expect(row.getByRole("alert")).toHaveText("Disk full");
      await switchProjectSettingsTarget(page, other.projectId, other.projectDisplayName);
      await expect(row.getByRole("alert")).toHaveCount(0);
      await expect(row.getByRole("button")).toBeEnabled();
    } finally {
      await other.cleanup();
    }
  });

  test("abandoned isolation save does not toast on the next settings target", async ({
    page,
    editableProject,
  }) => {
    const other = await seedWorkspace({ repoPrefix: "isolation-pending-target-" });
    try {
      const gate = await holdProjectIsolationSave(page);
      await openProjects(page);
      await openProjectSettings(page, editableProject.name);
      const row = page.getByTestId("project-isolation-row");
      await row.getByRole("button").click();
      await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
      await expect(row.getByRole("button")).toBeDisabled();
      await switchProjectSettingsTarget(page, other.projectId, other.projectDisplayName);
      await gate.commit();
      await gate.acknowledge();
      await expect(row.getByRole("button")).toBeEnabled();
      await expect(row).toContainText("Remember last");
      await expect(page.getByText("Workspace isolation updated", { exact: true })).toHaveCount(0);
    } finally {
      await other.cleanup();
    }
  });

  test("committed external isolation update clears a failed save alert", async ({
    page,
    editableProject,
  }) => {
    const client = await connectSeedClient();
    try {
      const gate = await holdProjectIsolationSave(page);
      await openProjects(page);
      await openProjectSettings(page, editableProject.name);
      const row = page.getByTestId("project-isolation-row");
      await row.getByRole("button").click();
      await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
      gate.fail();
      await expect(row.getByRole("alert")).toHaveText("Disk full");
      const projectId = (await client.fetchWorkspaces()).entries.find(
        (entry) => entry.projectRootPath === editableProject.path,
      )?.projectId;
      if (!projectId) throw new Error("Missing settings project");
      await client.setProjectIsolation(projectId, "local");
      await expect(row).toContainText("Local");
      await expect(row.getByRole("alert")).toHaveCount(0);
      await expect(row.getByRole("button")).toBeEnabled();
    } finally {
      await client.close();
    }
  });

  test("isolation success still toasts when committed update arrives before acknowledgement", async ({
    page,
    editableProject,
  }) => {
    const gate = await holdProjectIsolationSave(page);
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    const row = page.getByTestId("project-isolation-row");
    await row.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Local", exact: true }).click();
    await expect(row.getByRole("button")).toBeDisabled();
    await gate.commit();
    await expect(row).toContainText("Local");
    await expect(row.getByRole("button")).toBeDisabled();
    await gate.acknowledge();
    await expect(row.getByRole("button")).toBeEnabled();
    await expect(page.getByText("Workspace isolation updated", { exact: true })).toBeVisible();
  });

  test("project isolation persists independently of paseo.json", async ({
    page,
    editableProject,
  }) => {
    const before = await readProjectConfigFile(editableProject);
    await gotoAppShell(page);
    const projectRow = page
      .locator('[data-testid^="sidebar-project-row-"]')
      .filter({ hasText: editableProject.name })
      .first();
    await expect(projectRow).toBeVisible({ timeout: 30_000 });
    const testId = await projectRow.getAttribute("data-testid");
    if (!testId) throw new Error("Sidebar project row has no identity");
    await openProjectSettingsFromSidebar(page, testId.replace("sidebar-project-row-", ""));
    const row = page.getByTestId("project-isolation-row");
    await expect(row).toBeVisible();
    await expect(page.getByTestId("save-button")).toBeEnabled();
    await row.getByRole("button").click();
    await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
    await expect(page.getByText("Workspace isolation updated", { exact: true })).toBeVisible();
    await expect(row).toContainText("New worktree");
    expect(await readProjectConfigFile(editableProject)).toBe(before);
    await expect(page.getByTestId("save-button")).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("project-isolation-settings.png") });
    await page.reload();
    await expect(page.getByTestId("project-isolation-row")).toContainText("New worktree");
  });

  test("freshly-added project with no workspace is editable from the sidebar without a reload", async ({
    page,
  }) => {
    const repo = await createTempGitRepo("projects-settings-empty-");
    const client = await connectSeedClient();
    let projectViewKey: string | null = null;

    try {
      await gotoAppShell(page);

      projectViewKey = await addProjectFromSidebar(page, repo.path);
      await openProjectSettingsFromSidebar(page, projectViewKey);

      await expectProjectSettingsFormVisible(page);
      await expect(page.getByTestId("project-settings-back-button")).not.toBeVisible();
    } finally {
      if (projectViewKey) {
        const project = (await client.listProjects()).projects.find(
          (entry) => entry.projectKey === projectViewKey,
        );
        expect(project).toBeDefined();
        await client.removeProject(project!.projectId);
        expect(
          (await client.listProjects()).projects.map((entry) => entry.projectKey),
        ).not.toContain(projectViewKey);
      }
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    }
  });

  test("edits worktree setup, navigates within the host, and removes a script", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    await expectNoUncommittedSetupWarning(page);
    await editWorktreeSetup(page, updatedSetup);
    await clickSaveProjectSettings(page);
    await expectProjectConfigSaved(editableProject);
    await expectUncommittedSetupWarning(page);

    commitPaseoConfig(editableProject.path);
    await returnToProjectsList(page);
    await openProjectSettings(page, editableProject.name);
    await expectNoUncommittedSetupWarning(page);

    await test.step("navigation stays inside the selected host", async () => {
      await expectProjectHostContextHidden(page);
      await returnToProjectsList(page);
      await openProjectSettings(page, editableProject.name);
      await expectProjectSettingsHistoryRoundTrip(page, editableProject.name);
    });

    await test.step("removing a script leaves the committed setup unchanged", async () => {
      await expectScriptRowCount(page, 1);
      await removeProjectScript(page, "dev");
      await expectScriptRowCount(page, 0);
      await expectEmptyScriptList(page);
      await clickSaveProjectSettings(page);
      await expectNoUncommittedSetupWarning(page);
    });
  });

  test("user edits worktree setup on a non-GitHub remote project", async ({
    page,
    gitlabRemoteProject,
  }) => {
    expect(gitlabRemoteProject.name).toBe(path.basename(gitlabRemoteProject.path));
    await openProjects(page);
    await openProjectSettings(page, gitlabRemoteProject.name);
    await editWorktreeSetup(page, updatedSetup);
    await clickSaveProjectSettings(page);
    await expectProjectConfigSaved(gitlabRemoteProject);
  });

  test("renames a project, reopens the saved edit sheet, and adds an icon", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    await openProjectEditSheet(page);
    await fillProjectName(page, "Renamed project");
    await saveProjectEdits(page);

    await expectProjectEditSaved(page);
    await expectProjectTitle(page, "Renamed project");

    await test.step("reopening seeds the saved name with no unsaved changes", async () => {
      await openProjectEditSheet(page);
      await expectProjectEditName(page, "Renamed project");
      await expectProjectEditsSaveDisabled(page);
    });

    await test.step("an icon can be saved without another name change", async () => {
      await chooseProjectIconImage(page, {
        name: "logo.png",
        mimeType: "image/png",
        buffer: PNG_1X1,
      });
      await saveProjectEdits(page);
      await expectProjectEditSaved(page);
      await expectProjectTitle(page, "Renamed project");
    });
  });

  test("user sets a project name and icon in one save", async ({ page, editableProject }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    await openProjectEditSheet(page);
    await fillProjectName(page, "Both at once");
    await chooseProjectIconImage(page, {
      name: "logo.png",
      mimeType: "image/png",
      buffer: PNG_1X1,
    });
    await saveProjectEdits(page);

    await expectProjectEditSaved(page);
    await expectProjectTitle(page, "Both at once");
  });

  test("project edit keeps a rejected icon URL actionable", async ({ page, editableProject }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    await openProjectEditSheet(page);
    await fillProjectIconUrl(page, "file:///etc/passwd");
    await saveProjectEdits(page);

    await expectProjectEditFailed(page, "URL must use HTTP or HTTPS without credentials");
  });
});

test.describe("Projects settings — compact navigation", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("project isolation saves through compact Settings navigation", async ({
    page,
    editableProject,
  }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await openProjectSettings(page, editableProject.name);
    const row = page.getByTestId("project-isolation-row");
    await expect(row).toContainText("Remember last");
    await row.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Local", exact: true }).click();
    await expect(row).toContainText("Local");
    await page.reload();
    await expect(row).toContainText("Local");
    await row.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Remember last", exact: true }).click();
    await expect(row).toContainText("Remember last");
    await expect(page.getByTestId("save-button")).toBeEnabled();
  });

  test("project Back returns through Projects and Settings without reopening the project", async ({
    page,
    editableProject,
  }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect(page).toHaveURL(buildProjectsSettingsRoute(getServerId()));

    await openProjectSettings(page, editableProject.name);
    await expect(page.getByRole("button", { name: "Back", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Back to projects", exact: true })).toHaveCount(
      0,
    );

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(buildProjectsSettingsRoute(getServerId()));

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(buildSettingsRoute());
    await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  });
});

test.describe("Projects settings — error UX", () => {
  test("stale-write callout appears on save, disables save, and reload clears it", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    // Bump the file on disk so the daemon detects a revision mismatch on save.
    await bumpPaseoConfigOnDisk(editableProject.path);

    await clickSaveProjectSettings(page);

    await expectProjectSettingsError(page, "stale");
    await expectSaveButtonDisabled(page);

    await clickReloadProjectSettings(page);

    await expectNoProjectSettingsError(page, "stale");
    await expectProjectSettingsFormVisible(page);
  });

  test("invalid paseo.json shows read-error callout, reload after fix shows form", async ({
    page,
    editableProject,
  }) => {
    await corruptPaseoConfig(editableProject.path);

    await openProjects(page);
    await navigateToProjectSettings(page, editableProject.name);

    await expectProjectSettingsError(page, "invalid");
    await expectProjectSettingsFormHidden(page);

    // Restore a valid config so the reload succeeds.
    await restorePaseoConfig(editableProject.path, initialPaseoConfig);

    await clickReloadProjectSettings(page);

    await expectNoProjectSettingsError(page, "invalid");
    await expectProjectSettingsFormVisible(page);
  });

  test("write_failed callout appears on save with blocked directory, retry re-attempts, reload clears it", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    await blockPaseoConfigWrites(editableProject.path);

    await clickSaveProjectSettings(page);

    await expectProjectSettingsError(page, "write_failed");
    await expectWriteFailedCalloutActions(page);

    await clickRetryProjectSettingsSave(page);
    await expectProjectSettingsError(page, "write_failed");

    await unblockPaseoConfigWrites(editableProject.path);
    await clickReloadProjectSettings(page);
    await expectNoProjectSettingsError(page, "write_failed");
    await expectProjectSettingsFormVisible(page);
  });

  test("read-transport failure shows callout, reload recovers", async ({
    page,
    editableProject,
  }) => {
    // Reject read_project_config_request calls until the user clicks Reload.
    // This keeps automatic reconnect refetches from racing past the callout.
    const transportFailure = await installReadTransportFailure(page);

    await openProjects(page);
    await navigateToProjectSettings(page, editableProject.name);

    await expectProjectSettingsError(page, "transport");
    await expectProjectSettingsFormHidden(page);

    // Retry Reload until the refetch wins any in-flight error-state rendering.
    transportFailure.allowRecovery();
    await expect(async () => {
      await clickReloadProjectSettings(page);
      await expectNoProjectSettingsError(page, "transport", 3_000);
    }).toPass({ timeout: 15_000 });
    await expectProjectSettingsFormVisible(page);
  });

  test("project settings shows no-target state when daemon connection drops", async ({
    page,
    editableProject,
  }) => {
    const gate = await installDaemonConnectionGate(page);

    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    // Closing with code 1001 (Going Away) transitions DaemonClient to "error" state.
    // The NoEditableTarget UI renders via isHostGone check regardless of state.
    await gate.drop();

    await expectNoEditableTarget(page);
  });
});
