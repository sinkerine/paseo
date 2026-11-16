import { expect, test } from "vitest";
import { normalizeWorkspaceDescriptors } from "./workspace-descriptors.js";
import { SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { validateWSOutboundMessage } from "@getpaseo/protocol/validation/ws-outbound";

const workspace = {
  id: "workspace",
  projectId: "project",
  projectDisplayName: "Project",
  projectRootPath: "/repo",
  projectKind: "git" as const,
  workspaceKind: "local_checkout" as const,
  name: "main",
  status: "done" as const,
  activityAt: null,
  scripts: [],
  archivingAt: null,
  project: {
    projectKey: "key",
    projectName: "Project",
    checkout: {
      cwd: "/repo/sub",
      isGit: true,
      currentBranch: null,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  },
  githubRuntime: {
    pullRequest: {
      url: "https://forge/pull/1",
      title: "Change",
      state: "OPEN",
      baseRefName: "main",
      headRefName: "branch",
      isMerged: false,
      mergeable: "FUTURE",
    },
  },
};

test("normalizes omitted workspace fields across list, live update and every creation response", () => {
  const messages = [
    {
      type: "fetch_workspaces_response",
      payload: {
        entries: [workspace],
        emptyProjects: [],
        requestId: "list",
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      },
    },
    { type: "workspace_update", payload: { kind: "upsert", workspace } },
    {
      type: "open_project_response",
      payload: { requestId: "open", workspace, error: null, errorCode: null },
    },
    {
      type: "workspace.create.response",
      payload: { requestId: "create", workspace, error: null, setupTerminalId: null },
    },
    {
      type: "create_paseo_worktree_response",
      payload: { requestId: "legacy", workspace, error: null, setupTerminalId: null },
    },
    {
      type: "agent.create.response",
      payload: {
        requestId: "agent",
        agent: null,
        error: null,
        creation: {
          kind: "agent",
          idempotencyKey: "key",
          revision: 1,
          phase: "workspace_ready",
          workspaceId: "workspace",
          agentId: null,
          workspace,
          error: null,
        },
      },
    },
    {
      type: "workspace.create.update",
      payload: {
        kind: "workspace",
        idempotencyKey: "key",
        revision: 1,
        phase: "workspace_ready",
        workspaceId: "workspace",
        agentId: null,
        workspace,
        error: null,
      },
    },
    {
      type: "agent.create.update",
      payload: {
        kind: "agent",
        idempotencyKey: "key",
        revision: 1,
        phase: "workspace_ready",
        workspaceId: "workspace",
        agentId: null,
        workspace,
        error: null,
      },
    },
    {
      type: "creation.subscribe.response",
      payload: {
        requestId: "subscribe",
        snapshot: {
          kind: "workspace",
          idempotencyKey: "key",
          revision: 1,
          phase: "workspace_ready",
          workspaceId: "workspace",
          agentId: null,
          workspace,
          error: null,
        },
        error: null,
      },
    },
  ];
  for (const message of messages) {
    const decoded = validateWSOutboundMessage({ type: "session", message });
    if (!decoded.success || decoded.data.type !== "session")
      throw new Error("Legacy message rejected");
    const normalized = normalizeWorkspaceDescriptors(decoded.data.message);
    const encoded = JSON.stringify(normalized);
    expect(encoded).toContain('"workspaceDirectory":"/repo"');
    expect(encoded).toContain('"statusEnteredAt":null');
    expect(encoded).toContain('"worktreeRoot":"/repo/sub"');
    expect(encoded).toContain('"mergeable":"UNKNOWN"');
  }
});

test("preserves explicit workspace fields and unrelated messages", () => {
  const message = SessionOutboundMessageSchema.parse({
    type: "workspace_update",
    payload: {
      kind: "upsert",
      workspace: {
        ...workspace,
        project: undefined,
        githubRuntime: null,
        workspaceDirectory: "/repo/sub",
        statusEnteredAt: "now",
      },
    },
  });
  expect(normalizeWorkspaceDescriptors(message)).toEqual(message);
  const unrelated = SessionOutboundMessageSchema.parse({
    type: "project.isolation.set.response",
    payload: {
      requestId: "set",
      projectId: "project",
      accepted: true,
      defaultIsolation: null,
      error: null,
    },
  });
  expect(normalizeWorkspaceDescriptors(unrelated)).toBe(unrelated);
});

const pullRequest = workspace.githubRuntime.pullRequest;

test.each(["MERGEABLE", "CONFLICTING", "UNKNOWN", "FUTURE", null, 42, true, {}, [], undefined])(
  "normalizes mergeable %j after generated validation while preserving unknown keys",
  (mergeable) => {
    const decoded = validateWSOutboundMessage({
      type: "session",
      message: {
        type: "workspace_update",
        payload: {
          kind: "upsert",
          workspace: {
            ...workspace,
            extraWorkspace: true,
            githubRuntime: {
              extraRuntime: true,
              pullRequest: { ...pullRequest, mergeable, extraPullRequest: true },
            },
          },
        },
      },
    });
    if (!decoded.success || decoded.data.type !== "session") throw new Error("Wire rejected");
    const normalized = normalizeWorkspaceDescriptors(decoded.data.message);
    expect(normalized).toMatchObject({
      payload: {
        workspace: {
          extraWorkspace: true,
          githubRuntime: {
            extraRuntime: true,
            pullRequest: {
              extraPullRequest: true,
              mergeable:
                mergeable === undefined || mergeable === "MERGEABLE" || mergeable === "CONFLICTING"
                  ? mergeable
                  : "UNKNOWN",
            },
          },
        },
      },
    });
  },
);

test.each([
  { isGit: false, isPaseoOwnedWorktree: false, mainRepoRoot: null, expected: null },
  { isGit: true, isPaseoOwnedWorktree: false, mainRepoRoot: null, expected: "/repo/sub" },
  { isGit: true, isPaseoOwnedWorktree: true, mainRepoRoot: "/repo", expected: "/repo/sub" },
])("preserves checkout discriminants and explicit roots: %j", ({ expected, ...variant }) => {
  for (const worktreeRoot of [undefined, expected]) {
    const decoded = SessionOutboundMessageSchema.parse({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: {
          ...workspace,
          project: {
            ...workspace.project,
            checkout: { ...workspace.project.checkout, ...variant, worktreeRoot },
          },
        },
      },
    });
    expect(normalizeWorkspaceDescriptors(decoded)).toMatchObject({
      payload: {
        workspace: {
          project: { checkout: { ...variant, worktreeRoot: expected } },
        },
      },
    });
  }
});

test.each([undefined, null, { pullRequest: undefined }, { pullRequest: null }])(
  "preserves optional runtime wrappers: %j",
  (githubRuntime) => {
    const decoded = SessionOutboundMessageSchema.parse({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: { ...workspace, project: undefined, githubRuntime },
      },
    });
    expect(normalizeWorkspaceDescriptors(decoded)).toMatchObject({
      payload: {
        workspace: {
          project: undefined,
          githubRuntime,
        },
      },
    });
  },
);

test.each(["C:\\repo", "/repo/sub"])(
  "normalizes omitted checkout roots without changing path spelling: %s",
  (cwd) => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: {
          ...workspace,
          project: { ...workspace.project, checkout: { ...workspace.project.checkout, cwd } },
        },
      },
    });
    expect(normalizeWorkspaceDescriptors(parsed)).toMatchObject({
      payload: {
        workspace: {
          project: { checkout: { cwd, worktreeRoot: cwd } },
        },
      },
    });
  },
);
