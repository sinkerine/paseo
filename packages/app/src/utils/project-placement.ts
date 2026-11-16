import type { ProjectPlacementPayload } from "@getpaseo/protocol/messages";
import {
  normalizeProjectPlacement,
  type NormalizedProjectPlacement,
} from "@getpaseo/client/internal/daemon-client";
import { deriveProjectKey, deriveProjectName } from "@/utils/agent-grouping";

function normalizeWorkingDirectory(cwd: string): string {
  const trimmed = cwd.trim();
  return trimmed.length > 0 ? trimmed : ".";
}

export function deriveProjectPlacementFromCwd(cwd: string): NormalizedProjectPlacement {
  const normalizedCwd = normalizeWorkingDirectory(cwd);
  const projectKey = deriveProjectKey(normalizedCwd);

  return {
    projectKey,
    projectName: deriveProjectName(projectKey),
    workspaceName: null,
    checkout: {
      cwd: normalizedCwd,
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  };
}

export function resolveProjectPlacement(input: {
  projectPlacement: ProjectPlacementPayload | null | undefined;
  cwd: string;
}): NormalizedProjectPlacement {
  return input.projectPlacement == null
    ? deriveProjectPlacementFromCwd(input.cwd)
    : normalizeProjectPlacement(input.projectPlacement);
}
