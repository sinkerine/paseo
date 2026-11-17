import type { ProjectIsolation } from "@getpaseo/protocol/messages";

export interface WorkspaceIsolationDraftState {
  targetKey: string;
  manualIsolation: ProjectIsolation | null;
}

export type WorkspaceIsolationDraftAction =
  | { type: "target-changed"; targetKey: string }
  | { type: "manual-selected"; targetKey: string; value: ProjectIsolation };

export interface ResolveWorkspaceIsolationInput {
  draft: WorkspaceIsolationDraftState;
  targetKey: string;
  projectDefaultIsolation: ProjectIsolation | null;
  supportsMultiplicity: boolean;
  worktreeSupport: "supported" | "unsupported" | "unknown";
}

export interface ResolvedWorkspaceIsolation {
  nextDraft: WorkspaceIsolationDraftState;
  isolation: ProjectIsolation;
  effectiveIsolation: ProjectIsolation;
  canCreateWorktree: boolean;
  showRefPicker: boolean;
}

export function createIsolationTargetKey(input: {
  serverId: string;
  hostProjectId: string | null;
  projectViewKey: string | null | undefined;
}): string {
  // A route placement and its hydrated equivalence group name the same target.
  return JSON.stringify([input.serverId, input.hostProjectId ?? input.projectViewKey ?? null]);
}

export function createWorkspaceIsolationDraftState(
  targetKey: string,
): WorkspaceIsolationDraftState {
  return { targetKey, manualIsolation: null };
}

export function reduceWorkspaceIsolationDraftState(
  state: WorkspaceIsolationDraftState,
  action: WorkspaceIsolationDraftAction,
): WorkspaceIsolationDraftState {
  if (action.type === "manual-selected") {
    return { targetKey: action.targetKey, manualIsolation: action.value };
  }
  return state.targetKey === action.targetKey
    ? state
    : createWorkspaceIsolationDraftState(action.targetKey);
}

export function resolveWorkspaceIsolation(
  input: ResolveWorkspaceIsolationInput,
): ResolvedWorkspaceIsolation {
  const nextDraft = reduceWorkspaceIsolationDraftState(input.draft, {
    type: "target-changed",
    targetKey: input.targetKey,
  });
  const isolation = nextDraft.manualIsolation ?? input.projectDefaultIsolation ?? "worktree";
  const canCreateWorktree = input.supportsMultiplicity && input.worktreeSupport !== "unsupported";
  const isWorktree = isolation === "worktree" && canCreateWorktree;
  return {
    nextDraft,
    isolation,
    effectiveIsolation: isWorktree ? "worktree" : "local",
    canCreateWorktree,
    showRefPicker: !input.supportsMultiplicity || isWorktree,
  };
}
