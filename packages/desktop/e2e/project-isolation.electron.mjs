import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";

export function prepareProjectIsolationFixture(paseoHome) {
  const registryPath = path.join(paseoHome, "projects/projects.json");
  const projects = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const project = projects[0];
  const options = { cwd: project.rootPath, stdio: "pipe" };
  execFileSync("git", ["init", "-b", "main"], options);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Paseo Test",
      "-c",
      "user.email=test@getpaseo.local",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    options,
  );
  project.kind = "git";
  fs.writeFileSync(registryPath, JSON.stringify(projects));
  return project;
}

export async function runProjectIsolationRegression({ page, paseoHome, project, artifactDir }) {
  const registryPath = path.join(paseoHome, "projects/projects.json");
  const readDefault = () =>
    JSON.parse(fs.readFileSync(registryPath, "utf8")).find(
      (entry) => entry.projectId === project.projectId,
    ).defaultIsolation;
  const readWorkspaces = () =>
    JSON.parse(fs.readFileSync(path.join(paseoHome, "projects/workspaces.json"), "utf8"));
  await page.getByRole("button", { name: "Desktop browser workspace 1", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\//);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator('[data-testid="settings-sidebar"]:visible')
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await page.getByRole("button", { name: `Edit ${project.displayName}`, exact: true }).click();
  const row = page.getByTestId("project-isolation-row");
  await expect(row).toContainText("Remember last");
  await row.getByRole("button").click();
  await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
  await expect(page.getByText("Workspace isolation updated", { exact: true })).toBeVisible();
  await expect.poll(readDefault).toBe("worktree");
  await page.screenshot({ path: path.join(artifactDir, "project-isolation-settings.png") });
  await page.locator('[data-testid="settings-back-to-workspace"]:visible').click();
  await page.keyboard.press("Control+n");
  await expect(page).toHaveURL(/\/new(?:\?.*)?$/);
  await expect(page.getByTestId("workspace-create-isolation-trigger")).toContainText(
    "New worktree",
  );
  const before = new Set(readWorkspaces().map((entry) => entry.workspaceId));
  await page.getByTestId("workspace-create-submit").click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
  await expect
    .poll(() => readWorkspaces().filter((entry) => !before.has(entry.workspaceId)).length)
    .toBe(1);
  const created = readWorkspaces().find((entry) => !before.has(entry.workspaceId));
  expect(created.kind).toBe("worktree");
  await page.screenshot({ path: path.join(artifactDir, "project-isolation-created.png") });
  await page
    .locator('[data-testid^="sidebar-project-row-"]:visible')
    .filter({ hasText: project.displayName })
    .first()
    .hover();
  await page.locator('[data-testid^="sidebar-project-new-worktree-"]:visible').first().click();
  await expect(page.getByTestId("workspace-create-isolation-trigger")).toContainText(
    "New worktree",
  );
  await page.getByTestId("workspace-create-isolation-trigger").click();
  await page.getByTestId("workspace-create-isolation-local").click();
  const beforeLocal = new Set(readWorkspaces().map((entry) => entry.workspaceId));
  await page.getByTestId("workspace-create-submit").click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
  await expect
    .poll(() => readWorkspaces().filter((entry) => !beforeLocal.has(entry.workspaceId)).length)
    .toBe(1);
  const local = readWorkspaces().find((entry) => !beforeLocal.has(entry.workspaceId));
  expect(local.kind).toBe("local_checkout");
  expect(local.cwd).toBe(project.rootPath);
  expect(readDefault()).toBe("worktree");
  expect(fs.existsSync(path.join(project.rootPath, "paseo.json"))).toBe(false);
  return {
    projectId: project.projectId,
    defaultIsolation: readDefault(),
    worktreeWorkspaceId: created.workspaceId,
    localWorkspaceId: local.workspaceId,
    electronVersion: await page.evaluate(() => navigator.userAgent),
  };
}
