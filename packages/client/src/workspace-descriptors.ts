import type {
  CreationSnapshot,
  ProjectCheckoutLitePayload,
  ProjectPlacementPayload,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
  WorkspaceCreateResponse,
} from "@getpaseo/protocol/messages";

type NormalizedCheckout<T> = T extends ProjectCheckoutLitePayload
  ? Omit<T, "worktreeRoot"> & { worktreeRoot: T["isGit"] extends true ? string : null }
  : never;

export type NormalizedProjectPlacement = Omit<ProjectPlacementPayload, "checkout"> & {
  checkout: NormalizedCheckout<ProjectCheckoutLitePayload>;
};

type WorkspaceGitHubRuntimePayload = WorkspaceDescriptorPayload["githubRuntime"];

type PullRequest = NonNullable<NonNullable<WorkspaceGitHubRuntimePayload>["pullRequest"]>;
export type NormalizedWorkspaceGitHubRuntime =
  | (Omit<NonNullable<WorkspaceGitHubRuntimePayload>, "pullRequest"> & {
      pullRequest?:
        | (Omit<PullRequest, "mergeable"> & {
            mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
          })
        | null;
    })
  | null
  | undefined;

export type NormalizedWorkspaceDescriptor = Omit<
  WorkspaceDescriptorPayload,
  "workspaceDirectory" | "project" | "githubRuntime"
> & {
  workspaceDirectory: string;
  project?: NormalizedProjectPlacement;
  githubRuntime?: NormalizedWorkspaceGitHubRuntime;
};

type WithNormalizedDescriptors<T> = T extends WorkspaceDescriptorPayload
  ? NormalizedWorkspaceDescriptor
  : T extends ProjectPlacementPayload
    ? NormalizedProjectPlacement
    : T extends Date
      ? T
      : T extends readonly (infer Item)[]
        ? WithNormalizedDescriptors<Item>[]
        : T extends object
          ? { [Key in keyof T]: WithNormalizedDescriptors<T[Key]> }
          : T;

export type NormalizedCreationSnapshot = WithNormalizedDescriptors<CreationSnapshot>;
export type NormalizedWorkspaceCreateResponse = WithNormalizedDescriptors<WorkspaceCreateResponse>;

export type NormalizedSessionOutboundMessage = WithNormalizedDescriptors<SessionOutboundMessage>;

// COMPAT(checkoutRoots): added in v0.15.4, remove after 2027-05-14 once the daemon
// floor always sends worktreeRoot. Keep the wire fields optional.
export function normalizeProjectPlacement(
  project: ProjectPlacementPayload,
): NormalizedProjectPlacement {
  const checkout = project.checkout;
  if (checkout.worktreeRoot !== undefined) return project as NormalizedProjectPlacement;
  return {
    ...project,
    checkout: checkout.isGit
      ? { ...checkout, worktreeRoot: checkout.worktreeRoot ?? checkout.cwd }
      : { ...checkout, worktreeRoot: null },
  };
}

export function normalizeWorkspaceGitHubRuntime(
  runtime: WorkspaceGitHubRuntimePayload,
): NormalizedWorkspaceGitHubRuntime {
  if (runtime == null) return runtime;
  const mergeable = runtime.pullRequest?.mergeable;
  return {
    ...runtime,
    pullRequest:
      runtime.pullRequest == null
        ? runtime.pullRequest
        : {
            ...runtime.pullRequest,
            mergeable:
              mergeable === undefined || mergeable === "MERGEABLE" || mergeable === "CONFLICTING"
                ? mergeable
                : "UNKNOWN",
          },
  };
}

function normalizeWorkspace(workspace: WorkspaceDescriptorPayload): NormalizedWorkspaceDescriptor {
  return {
    ...workspace,
    workspaceDirectory: workspace.workspaceDirectory ?? workspace.projectRootPath,
    project:
      workspace.project === undefined ? undefined : normalizeProjectPlacement(workspace.project),
    githubRuntime: normalizeWorkspaceGitHubRuntime(workspace.githubRuntime),
  };
}

function normalizeNullableWorkspace(
  workspace: WorkspaceDescriptorPayload | null | undefined,
): NormalizedWorkspaceDescriptor | null {
  return workspace ? normalizeWorkspace(workspace) : null;
}

function normalizeOptionalCreation(
  snapshot: CreationSnapshot | undefined,
): NormalizedCreationSnapshot | undefined {
  return snapshot ? normalizeCreation(snapshot) : undefined;
}

function normalizeCreation(
  snapshot: CreationSnapshot,
): WithNormalizedDescriptors<CreationSnapshot> {
  return {
    ...snapshot,
    workspace: snapshot.workspace ? normalizeWorkspace(snapshot.workspace) : undefined,
  };
}

// COMPAT(workspaceDescriptorDefaults): added in v0.15.4, remove after 2027-05-14 once
// the daemon floor always sends workspaceDirectory. Wire validation remains structural.
export function normalizeWorkspaceDescriptors(
  message: SessionOutboundMessage,
): NormalizedSessionOutboundMessage {
  switch (message.type) {
    case "fetch_agents_response":
    case "fetch_agent_history_response":
      return {
        ...message,
        payload: {
          ...message.payload,
          entries: message.payload.entries.map((entry) => ({
            ...entry,
            project: normalizeProjectPlacement(entry.project),
          })),
        },
      };
    case "agent_update":
      if (message.payload.kind !== "upsert") return { ...message, payload: message.payload };
      return {
        ...message,
        payload: {
          ...message.payload,
          project:
            message.payload.project == null
              ? message.payload.project
              : normalizeProjectPlacement(message.payload.project),
        },
      };
    case "fetch_agent_response":
      return {
        ...message,
        payload: {
          ...message.payload,
          project:
            message.payload.project == null
              ? message.payload.project
              : normalizeProjectPlacement(message.payload.project),
        },
      };
    case "fetch_workspaces_response":
      return {
        ...message,
        payload: { ...message.payload, entries: message.payload.entries.map(normalizeWorkspace) },
      };
    case "workspace_update":
      if (message.payload.kind !== "upsert") return { ...message, payload: message.payload };
      return {
        ...message,
        payload: { ...message.payload, workspace: normalizeWorkspace(message.payload.workspace) },
      };
    case "open_project_response":
      return {
        ...message,
        payload: {
          ...message.payload,
          workspace: normalizeNullableWorkspace(message.payload.workspace),
        },
      };
    case "create_paseo_worktree_response":
      return {
        ...message,
        payload: {
          ...message.payload,
          workspace: normalizeNullableWorkspace(message.payload.workspace),
        },
      };
    case "workspace.create.response":
      return {
        ...message,
        payload: {
          ...message.payload,
          workspace: normalizeNullableWorkspace(message.payload.workspace),
          creation: normalizeOptionalCreation(message.payload.creation),
        },
      };
    case "agent.create.response":
      return {
        ...message,
        payload: {
          ...message.payload,
          creation: normalizeOptionalCreation(message.payload.creation),
        },
      };
    case "workspace.create.update":
      return {
        ...message,
        payload: {
          ...normalizeCreation(message.payload),
          subscriptionId: message.payload.subscriptionId,
        },
      };
    case "agent.create.update":
      return {
        ...message,
        payload: {
          ...normalizeCreation(message.payload),
          subscriptionId: message.payload.subscriptionId,
        },
      };
    case "creation.subscribe.response":
      return {
        ...message,
        payload: {
          ...message.payload,
          snapshot: message.payload.snapshot ? normalizeCreation(message.payload.snapshot) : null,
        },
      };
    default:
      return message;
  }
}
