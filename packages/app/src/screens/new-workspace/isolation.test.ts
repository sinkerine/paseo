import { describe, expect, test } from "vitest";
import {
  createIsolationTargetKey,
  createWorkspaceIsolationDraftState,
  reduceWorkspaceIsolationDraftState,
  resolveWorkspaceIsolation,
  shouldPersistGlobalIsolationPreference,
} from "./isolation";

describe("workspace isolation draft", () => {
  const targetKey = createIsolationTargetKey({
    serverId: "H1",
    hostProjectId: "A",
    projectViewKey: "provisional",
  });
  test("project defaults win and unsupported projects create locally", () => {
    const input = {
      draft: createWorkspaceIsolationDraftState(targetKey),
      targetKey,
      projectDefaultIsolation: "worktree" as const,
      preferredIsolation: "local" as const,
      supportsMultiplicity: true,
      worktreeSupport: "supported" as const,
    };
    expect(resolveWorkspaceIsolation(input)).toMatchObject({
      isolation: "worktree",
      effectiveIsolation: "worktree",
      showRefPicker: true,
    });
    expect(resolveWorkspaceIsolation({ ...input, worktreeSupport: "unsupported" })).toMatchObject({
      effectiveIsolation: "local",
      canCreateWorktree: false,
    });
    expect(shouldPersistGlobalIsolationPreference({ projectDefaultIsolation: "local" })).toBe(
      false,
    );
    expect(shouldPersistGlobalIsolationPreference({ projectDefaultIsolation: null })).toBe(true);
  });
  for (const other of [
    { serverId: "H1", hostProjectId: "B" },
    { serverId: "H2", hostProjectId: "A" },
  ]) {
    test(`clears overrides permanently through ${other.serverId}/${other.hostProjectId} and back`, () => {
      let draft = createWorkspaceIsolationDraftState(targetKey);
      draft = reduceWorkspaceIsolationDraftState(draft, {
        type: "manual-selected",
        targetKey,
        value: "worktree",
      });
      expect(draft.manualIsolation).toBe("worktree");
      const otherKey = createIsolationTargetKey({ ...other, projectViewKey: "group" });
      draft = reduceWorkspaceIsolationDraftState(draft, {
        type: "target-changed",
        targetKey: otherKey,
      });
      draft = reduceWorkspaceIsolationDraftState(draft, { type: "target-changed", targetKey });
      expect(
        resolveWorkspaceIsolation({
          draft,
          targetKey,
          projectDefaultIsolation: "local",
          preferredIsolation: "worktree",
          supportsMultiplicity: true,
          worktreeSupport: "supported",
        }).effectiveIsolation,
      ).toBe("local");
    });
  }
  test("adopts hydrated project default without resetting a pick on the same logical target", () => {
    expect(
      createIsolationTargetKey({ serverId: "H1", hostProjectId: "A", projectViewKey: "hydrated" }),
    ).toBe(targetKey);
    const draft = createWorkspaceIsolationDraftState(targetKey);
    const input = {
      draft,
      targetKey,
      projectDefaultIsolation: null,
      preferredIsolation: "local" as const,
      supportsMultiplicity: true,
      worktreeSupport: "unknown" as const,
    };
    expect(resolveWorkspaceIsolation(input).nextDraft).toBe(draft);
    expect(
      resolveWorkspaceIsolation({
        ...input,
        projectDefaultIsolation: "worktree",
        worktreeSupport: "supported",
      }).isolation,
    ).toBe("worktree");
    const manual = reduceWorkspaceIsolationDraftState(draft, {
      type: "manual-selected",
      targetKey,
      value: "local",
    });
    expect(
      resolveWorkspaceIsolation({ ...input, draft: manual, projectDefaultIsolation: "worktree" })
        .isolation,
    ).toBe("local");
  });
});
