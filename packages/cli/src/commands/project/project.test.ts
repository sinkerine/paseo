import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { runProjectIcon, projectIconSource } from "./icon.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProjectPath, runCreateCommand } from "./create.js";
import { runDeleteCommand } from "./delete.js";
import { createProjectCommand } from "./index.js";
import { runLsCommand } from "./ls.js";
import { resolveProjectName, runRenameCommand } from "./rename.js";

const project = {
  projectId: "project-1",
  projectDisplayName: "Paseo",
  projectCustomName: null,
  projectRootPath: "/tmp/paseo",
  projectKind: "git" as const,
};
const addProject = vi.fn(async () => ({ project, error: null }));
const listProjects = vi.fn(async () => ({ projects: [project] }));
const renameProject = vi.fn(async (_projectId: string, name: string | null) => ({
  customName: name,
}));
const removeProject = vi.fn(async () => ({ removedWorkspaceIds: ["workspace-1"] }));
const setProjectIcon = vi.fn(async () => undefined);
const getProjectIcon = vi.fn(async () => ({
  icon: { data: "aWNvbg==", mimeType: "image/png" },
  error: null,
}));
const getLastServerInfoMessage = vi.fn(() => ({ features: { projectCustomIcon: true } }));
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  buildDaemonConnectionCommandError: vi.fn(({ error }: { error: unknown }) => error),
  connectToDaemon: vi.fn(async () => ({
    addProject,
    listProjects,
    renameProject,
    removeProject,
    setProjectIcon,
    getProjectIcon,
    getLastServerInfoMessage,
    close,
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("project commands", () => {
  it("exposes the complete project lifecycle", () => {
    expect(createProjectCommand().commands.map((command) => command.name())).toEqual([
      "create",
      "ls",
      "rename",
      "delete",
      "icon",
    ]);
  });

  it("creates a project from an absolute directory path", async () => {
    const result = await runCreateCommand(
      "relative/project",
      { daemonTarget: { kind: "instance", home: "/tmp/project-test" } },
      {} as never,
    );

    expect(addProject).toHaveBeenCalledWith(path.resolve("relative/project"));
    expect(result.data).toEqual({
      projectId: "project-1",
      name: "Paseo",
      kind: "git",
      path: "/tmp/paseo",
    });
    expect(close).toHaveBeenCalled();
  });

  it("resolves paths locally and leaves daemon-owned paths unchanged", () => {
    expect(resolveProjectPath({ cwd: "/home/user", pathArg: "repo" })).toBe(
      path.resolve("/home/user/repo"),
    );
    expect(resolveProjectPath({ cwd: "/home/user" })).toBe(path.resolve("/home/user"));
    expect(
      resolveProjectPath({ cwd: "/home/user", pathArg: "/srv/repo", daemonTarget: "host:6767" }),
    ).toBe("/srv/repo");
    expect(
      resolveProjectPath({ cwd: "/home/user", pathArg: "~/repo", daemonTarget: "host:6767" }),
    ).toBe("~/repo");
  });

  it("requires a daemon-owned path for an explicit target", () => {
    expect(() => resolveProjectPath({ cwd: "/home/user", daemonTarget: "host:6767" })).toThrow();
  });

  it("lists projects", async () => {
    const result = await runLsCommand(
      { daemonTarget: { kind: "instance", home: "/tmp/project-test" } },
      {} as never,
    );

    expect(listProjects).toHaveBeenCalled();
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.projectId).toBe("project-1");
  });

  it("renames and resets a project", async () => {
    expect(resolveProjectName({ name: "  New name  " })).toBe("New name");
    expect(resolveProjectName({ reset: true })).toBeNull();

    const result = await runRenameCommand(
      "project-1",
      "  New name  ",
      { daemonTarget: { kind: "instance", home: "/tmp/project-test" } },
      {} as never,
    );
    expect(renameProject).toHaveBeenCalledWith("project-1", "New name");
    expect(result.data).toEqual({ projectId: "project-1", name: "New name" });
  });

  it("uploads a local project icon, reads it, and restores automatic selection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-cli-icon-"));
    try {
      const file = path.join(root, "icon.png");
      await writeFile(file, "icon");
      const options = { daemonTarget: { kind: "instance" as const, home: "/tmp/project-test" } };
      await runProjectIcon("project-1", file, "set", options);
      expect(setProjectIcon).toHaveBeenCalledWith("project-1", {
        type: "upload",
        data: "aWNvbg==",
      });
      expect((await runProjectIcon("project-1", undefined, "get", options)).data).toEqual({
        projectId: "project-1",
        icon: { data: "aWNvbg==", mimeType: "image/png" },
      });
      await runProjectIcon("project-1", undefined, "reset", options);
      expect(setProjectIcon).toHaveBeenLastCalledWith("project-1", { type: "automatic" });
      await writeFile(file, Buffer.alloc(512 * 1024 + 1));
      await expect(projectIconSource(file)).rejects.toThrow(/512 KB/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers a website icon on the CLI machine before uploading", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      if (request.url === "/repo") {
        response.setHeader("Content-Type", "text/html");
        response.end('<link rel="icon" href="/avatar.png">');
      } else {
        response.setHeader("Content-Type", "image/png");
        response.end("icon");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test server address");
      const options = { daemonTarget: { kind: "instance" as const, home: "/tmp/project-test" } };
      await runProjectIcon("project-1", `http://127.0.0.1:${address.port}/repo`, "set", options);
      expect(requests).toEqual(["/repo", "/avatar.png"]);
      expect(setProjectIcon).toHaveBeenCalledWith("project-1", {
        type: "upload",
        data: "aWNvbg==",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });

  it("reports icon failures and closes the client", async () => {
    const options = { daemonTarget: { kind: "instance" as const, home: "/tmp/project-test" } };
    getLastServerInfoMessage.mockReturnValueOnce({ features: { projectCustomIcon: false } });
    await expect(runProjectIcon("project-1", undefined, "reset", options)).rejects.toThrow(
      /Update the host/,
    );
    setProjectIcon.mockRejectedValueOnce(new Error("Invalid icon"));
    await expect(runProjectIcon("project-1", undefined, "reset", options)).rejects.toThrow(
      "Invalid icon",
    );
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty project name", () => {
    expect(() => resolveProjectName({ name: "  " })).toThrow();
  });

  it("deletes a project", async () => {
    const result = await runDeleteCommand(
      "project-1",
      { daemonTarget: { kind: "instance", home: "/tmp/project-test" } },
      {} as never,
    );

    expect(removeProject).toHaveBeenCalledWith("project-1");
    expect(result.data).toEqual({
      projectId: "project-1",
      removedWorkspaceIds: ["workspace-1"],
    });
  });
});
