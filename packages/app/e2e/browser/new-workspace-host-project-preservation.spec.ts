import { selectSettingsHost } from "../support/helpers/settings";
import { openProjectSettings } from "../support/helpers/project-settings";
import { expect, test as base } from "../support/fixtures";
import { openProjectDirectoryWithHosts } from "../support/helpers/project-grouping";
import { projectPlacementViewKey } from "../support/helpers/project-view-key";
import {
  type IsolatedHostDaemon,
  startIsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import {
  expectNewWorkspaceProjectSelected,
  expectWorkspaceIsolationSelected,
  selectWorkspaceIsolation,
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceHost,
  selectNewWorkspaceProject,
} from "../support/helpers/new-workspace";
import { connectSeedClient, type SeedDaemonClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { addConnectedHostsAndReload } from "../support/helpers/hosts";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";
import { createTempGitRepo } from "../support/helpers/workspace";

const PRIMARY_HOST_LABEL = "Primary host";
const SECONDARY_HOST_LABEL = "Secondary host";
const SHARED_PROJECT_NAME = "Paseo";
const SHARED_REMOTE_URL = "https://github.com/getpaseo/paseo.git";

interface CreatedProject {
  projectId: string;
  projectKey: string;
  workspaceId: string;
}

interface CrossHostProjectScenario {
  contextWorkspaceId: string;
  primarySharedWorkspaceId: string;
  primaryProjectId: string;
  secondaryProjectId: string;
  selectedProjectViewKey: string;
  sharedProjectKey: string;
  secondaryHost: {
    serverId: string;
    label: string;
    port: number;
  };
}

async function createProject(
  client: SeedDaemonClient,
  input: { projectPath: string; projectName: string; workspaceName: string },
): Promise<CreatedProject> {
  const created = await client.createWorkspace({
    source: { kind: "directory", path: input.projectPath },
    title: input.workspaceName,
  });
  if (!created.workspace) {
    throw new Error(created.error ?? `Failed to create project ${input.projectName}`);
  }

  await client.renameProject(created.workspace.projectId, input.projectName);
  const listed = await client.listProjects();
  const project = listed.projects.find(
    (candidate) => candidate.projectId === created.workspace?.projectId,
  );
  if (!project?.projectKey) {
    throw new Error(`Created project ${created.workspace.projectId} has no project key`);
  }

  return {
    projectId: created.workspace.projectId,
    projectKey: project.projectKey,
    workspaceId: created.workspace.id,
  };
}

async function openNewWorkspaceFromContextProject(
  page: Parameters<typeof openProjectDirectoryWithHosts>[0],
  scenario: CrossHostProjectScenario,
): Promise<void> {
  await openProjectDirectoryWithHosts(page, {
    hosts: [scenario.secondaryHost],
    primaryLabel: PRIMARY_HOST_LABEL,
  });
  await expect(
    page.getByTestId(`sidebar-project-row-${scenario.selectedProjectViewKey}`),
  ).toBeVisible();
  await switchWorkspaceViaSidebar({
    page,
    serverId: getServerId(),
    workspaceId: scenario.contextWorkspaceId,
  });
  await openGlobalNewWorkspaceComposer(page);
  await expectNewWorkspaceProjectSelected(page, "Context project");
}

const test = base.extend<{ crossHostProject: CrossHostProjectScenario }>({
  crossHostProject: async ({ page: _page }, provide) => {
    const secondaryDaemon: IsolatedHostDaemon = await startIsolatedHostDaemon(
      "new-workspace-project-preservation-secondary",
    );
    const contextRepo = await createTempGitRepo("new-workspace-context-");
    const primarySharedRepo = await createTempGitRepo("new-workspace-paseo-primary-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const primaryDuplicateRepo = await createTempGitRepo("new-workspace-paseo-duplicate-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const secondaryFallbackRepo = await createTempGitRepo("new-workspace-fallback-");
    const secondarySharedRepo = await createTempGitRepo("new-workspace-paseo-secondary-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const primaryClient = await connectSeedClient();
    const secondaryClient = await connectSeedClient({ port: secondaryDaemon.port });
    const primaryProjects: CreatedProject[] = [];
    const secondaryProjects: CreatedProject[] = [];

    try {
      const contextProject = await createProject(primaryClient, {
        projectPath: contextRepo.path,
        projectName: "Context project",
        workspaceName: "Context workspace",
      });
      primaryProjects.push(contextProject);
      const primarySharedProject = await createProject(primaryClient, {
        projectPath: primarySharedRepo.path,
        projectName: SHARED_PROJECT_NAME,
        workspaceName: "Primary Paseo workspace",
      });
      primaryProjects.push(primarySharedProject);
      const primaryDuplicateProject = await createProject(primaryClient, {
        projectPath: primaryDuplicateRepo.path,
        projectName: "Paseo duplicate",
        workspaceName: "Duplicate Paseo workspace",
      });
      primaryProjects.push(primaryDuplicateProject);
      secondaryProjects.push(
        await createProject(secondaryClient, {
          projectPath: secondaryFallbackRepo.path,
          projectName: "Aardvark project",
          workspaceName: "Secondary fallback workspace",
        }),
      );
      const secondarySharedProject = await createProject(secondaryClient, {
        projectPath: secondarySharedRepo.path,
        projectName: SHARED_PROJECT_NAME,
        workspaceName: "Secondary Paseo workspace",
      });
      secondaryProjects.push(secondarySharedProject);

      if (
        primarySharedProject.projectKey !== primaryDuplicateProject.projectKey ||
        primarySharedProject.projectKey !== secondarySharedProject.projectKey
      ) {
        throw new Error("Expected the Paseo clones to have the same equivalence key");
      }

      await primaryClient.setProjectIsolation(primarySharedProject.projectId, "local");
      await secondaryClient.setProjectIsolation(secondarySharedProject.projectId, "worktree");
      await provide({
        contextWorkspaceId: contextProject.workspaceId,
        primarySharedWorkspaceId: primarySharedProject.workspaceId,
        primaryProjectId: primarySharedProject.projectId,
        secondaryProjectId: secondarySharedProject.projectId,
        selectedProjectViewKey: projectPlacementViewKey(
          getServerId(),
          primarySharedProject.projectId,
        ),
        sharedProjectKey: primarySharedProject.projectKey,
        secondaryHost: {
          serverId: secondaryDaemon.serverId,
          label: SECONDARY_HOST_LABEL,
          port: secondaryDaemon.port,
        },
      });
    } finally {
      for (const project of primaryProjects) {
        await primaryClient.removeProject(project.projectId).catch(() => undefined);
      }
      for (const project of secondaryProjects) {
        await secondaryClient.removeProject(project.projectId).catch(() => undefined);
      }
      await primaryClient.close().catch(() => undefined);
      await secondaryClient.close().catch(() => undefined);
      await contextRepo.cleanup().catch(() => undefined);
      await primarySharedRepo.cleanup().catch(() => undefined);
      await primaryDuplicateRepo.cleanup().catch(() => undefined);
      await secondaryFallbackRepo.cleanup().catch(() => undefined);
      await secondarySharedRepo.cleanup().catch(() => undefined);
      await secondaryDaemon.close().catch(() => undefined);
    }
  },
});

test.describe("New workspace host project preservation", () => {
  test.describe.configure({ timeout: 180_000 });

  test("project settings save only the selected host placement", async ({
    page,
    crossHostProject,
  }) => {
    await openProjectDirectoryWithHosts(page, {
      hosts: [crossHostProject.secondaryHost],
      primaryLabel: PRIMARY_HOST_LABEL,
    });
    const primary = await connectSeedClient();
    const secondary = await connectSeedClient({ port: crossHostProject.secondaryHost.port });
    try {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await selectSettingsHost(page, getServerId());
      await page
        .getByRole("navigation", { name: "Settings" })
        .getByRole("button", { name: "Projects", exact: true })
        .click();
      await openProjectSettings(page, SHARED_PROJECT_NAME);
      const row = page.getByTestId("project-isolation-row");
      await expect(row).toContainText("Local");
      await row.getByRole("button").click();
      await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
      await expect(row).toContainText("New worktree");
      expect(
        (await secondary.listProjects()).projects.find(
          (project) => project.projectId === crossHostProject.secondaryProjectId,
        )?.projectDefaultIsolation,
      ).toBe("worktree");
      await selectSettingsHost(page, crossHostProject.secondaryHost.serverId);
      await page
        .getByRole("navigation", { name: "Settings" })
        .getByRole("button", { name: "Projects", exact: true })
        .click();
      await openProjectSettings(page, SHARED_PROJECT_NAME);
      await expect(row).toContainText("New worktree");
      await row.getByRole("button").click();
      await page.getByRole("menuitem", { name: "Local", exact: true }).click();
      await expect(row).toContainText("Local");
      expect(
        (await primary.listProjects()).projects.find(
          (project) => project.projectId === crossHostProject.primaryProjectId,
        )?.projectDefaultIsolation,
      ).toBe("worktree");
    } finally {
      await primary.close();
      await secondary.close();
    }
  });

  test("keeps the equivalent project selected when one host has another clone", async ({
    page,
    crossHostProject,
  }) => {
    await openNewWorkspaceFromContextProject(page, crossHostProject);
    await selectNewWorkspaceProject(page, {
      projectKey: crossHostProject.sharedProjectKey,
      projectViewKey: crossHostProject.selectedProjectViewKey,
      projectDisplayName: SHARED_PROJECT_NAME,
    });
    await expectWorkspaceIsolationSelected(page, "local");
    await selectWorkspaceIsolation(page, "worktree");
    await selectNewWorkspaceHost(page, SECONDARY_HOST_LABEL);
    await expectWorkspaceIsolationSelected(page, "worktree");
    await selectNewWorkspaceHost(page, PRIMARY_HOST_LABEL);
    await expectWorkspaceIsolationSelected(page, "local");

    await expectNewWorkspaceProjectSelected(page, SHARED_PROJECT_NAME);
  });

  test("keeps the active workspace project selected when switching hosts", async ({
    page,
    crossHostProject,
  }) => {
    await openProjectDirectoryWithHosts(page, {
      hosts: [crossHostProject.secondaryHost],
      primaryLabel: PRIMARY_HOST_LABEL,
    });
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: crossHostProject.primarySharedWorkspaceId,
    });
    await openGlobalNewWorkspaceComposer(page);
    await expectNewWorkspaceProjectSelected(page, SHARED_PROJECT_NAME);

    await selectNewWorkspaceHost(page, SECONDARY_HOST_LABEL);

    await expectNewWorkspaceProjectSelected(page, SHARED_PROJECT_NAME);

    await addConnectedHostsAndReload(page, [crossHostProject.secondaryHost], {
      primaryLabel: PRIMARY_HOST_LABEL,
    });
    await expectNewWorkspaceProjectSelected(page, SHARED_PROJECT_NAME);
    await selectNewWorkspaceHost(page, SECONDARY_HOST_LABEL);

    await expectNewWorkspaceProjectSelected(page, SHARED_PROJECT_NAME);
  });
});
