import { describe, expect, it } from "vitest";
import type { ProjectDescriptor } from "@/stores/session-store";
import {
  selectProjectViewPlacements,
  selectWorkspaceStructureProjects,
  type SessionsSnapshot,
} from "@/stores/session-store-hooks/selectors";
import { buildSidebarWorkspacePlacementModel } from "@/hooks/sidebar-workspaces-view-model";
import { selectHostNotificationScope } from "./sidebar-notification-scope";

function project(projectId: string, projectKey = projectId): ProjectDescriptor {
  return {
    projectId,
    projectKey,
    projectDisplayName: projectId,
    projectCustomName: null,
    projectDefaultIsolation: null,
    projectRootPath: `/repos/${projectId}`,
    projectKind: "git",
  };
}

function snapshot(): SessionsSnapshot {
  return {
    sessions: {
      a: {
        hasHydratedWorkspaces: true,
        workspaces: new Map(),
        projects: new Map([
          ["a1", project("a1", "shared")],
          ["a2", project("a2", "other")],
        ]),
      },
      b: {
        hasHydratedWorkspaces: true,
        workspaces: new Map(),
        projects: new Map([["b1", project("b1", "shared")]]),
      },
    },
  };
}

function input(sessions = snapshot()) {
  return {
    serverId: "a",
    allServerIds: ["a", "b"],
    hostRegistryLoaded: true,
    hostFilters: [],
    projectFilters: [],
    sessions,
  };
}

describe("selectHostNotificationScope", () => {
  it("reports no scope for All projects and stale project keys", () => {
    expect(selectHostNotificationScope(input())).toBeUndefined();
    expect(
      selectHostNotificationScope({ ...input(), projectFilters: ["removed"] }),
    ).toBeUndefined();
  });

  it("reports each shared project's host-local ids", () => {
    const base = { ...input(), projectFilters: ["shared"] };
    expect(selectHostNotificationScope(base)).toEqual({ projectIds: ["a1"] });
    expect(selectHostNotificationScope({ ...base, serverId: "b" })).toEqual({ projectIds: ["b1"] });
  });

  it("sorts and deduplicates selected ids", () => {
    expect(
      selectHostNotificationScope({ ...input(), projectFilters: ["other", "shared", "other"] }),
    ).toEqual({ projectIds: ["a1", "a2"] });
  });

  it("excludes a host even for All projects", () => {
    expect(selectHostNotificationScope({ ...input(), hostFilters: ["b"] })).toEqual({
      projectIds: [],
    });
  });

  it("follows the sidebar fallback when pinned hosts are missing after registry load", () => {
    expect(selectHostNotificationScope({ ...input(), hostFilters: ["removed"] })).toBeUndefined();
    expect(
      selectHostNotificationScope({
        ...input(),
        hostFilters: ["removed"],
        hostRegistryLoaded: false,
      }),
    ).toEqual({ projectIds: [] });
  });

  it("recomputes a filtered host's scope after its directory hydrates", () => {
    const before = snapshot();
    before.sessions.b = { ...before.sessions.b, hasHydratedWorkspaces: false };
    const base = { ...input(before), serverId: "b", projectFilters: ["shared"] };
    expect(selectHostNotificationScope(base)).toEqual({ projectIds: [] });
    const after = {
      sessions: { ...before.sessions, b: { ...before.sessions.b, hasHydratedWorkspaces: true } },
    };
    expect(selectHostNotificationScope({ ...base, sessions: after })).toEqual({
      projectIds: ["b1"],
    });
  });

  it.each([
    { name: "a single host", allServerIds: ["b"] },
    { name: "hosts with distinct project keys", allServerIds: ["a", "b"] },
  ])("waits for directory hydration for $name before resolving pinned keys", ({ allServerIds }) => {
    const before: SessionsSnapshot = {
      sessions: {
        a: {
          hasHydratedWorkspaces: true,
          workspaces: new Map(),
          projects: new Map([["a1", project("a1", "alpha")]]),
        },
        b: { hasHydratedWorkspaces: false, workspaces: new Map(), projects: new Map() },
      },
    };
    const base = { ...input(before), serverId: "b", allServerIds, projectFilters: ["beta"] };
    expect(selectHostNotificationScope(base)).toEqual({ projectIds: [] });

    const hydrated: SessionsSnapshot = {
      sessions: {
        ...before.sessions,
        b: {
          ...before.sessions.b,
          hasHydratedWorkspaces: true,
          projects: new Map([["b1", project("b1", "beta")]]),
        },
      },
    };
    expect(selectHostNotificationScope({ ...base, sessions: hydrated })).toEqual({
      projectIds: ["b1"],
    });

    const stale: SessionsSnapshot = {
      sessions: {
        ...hydrated.sessions,
        b: { ...hydrated.sessions.b, projects: new Map([["b2", project("b2", "gamma")]]) },
      },
    };
    expect(selectHostNotificationScope({ ...base, sessions: stale })).toBeUndefined();
  });

  it("keeps All projects unrestricted before directory hydration", () => {
    const sessions: SessionsSnapshot = {
      sessions: {
        b: { hasHydratedWorkspaces: false, workspaces: new Map(), projects: new Map() },
      },
    };
    expect(
      selectHostNotificationScope({ ...input(sessions), serverId: "b", allServerIds: ["b"] }),
    ).toBeUndefined();
  });

  it("uses the sidebar's view keys for shared projects and placement collisions", () => {
    const sessions = snapshot();
    sessions.sessions.a.projects = new Map([
      ["a1", project("a1", "shared")],
      ["dup1", project("dup1", "duplicate")],
      ["dup2", project("dup2", "duplicate")],
      ["collision", project("collision", JSON.stringify(["a", "dup1"]))],
    ]);
    const serverIds = ["a", "b"];
    const placements = selectProjectViewPlacements(sessions, serverIds);
    const sidebar = buildSidebarWorkspacePlacementModel({
      projects: selectWorkspaceStructureProjects(sessions, serverIds),
    });
    expect(placements.map((entry) => entry.viewKey)).toEqual(
      sidebar.projects.map((entry) => entry.viewKey),
    );
    const collisionKey = JSON.stringify(["placement", "a", "dup1", 0]);
    expect(placements.map((entry) => entry.viewKey)).toContain(collisionKey);
    expect(
      selectHostNotificationScope({ ...input(sessions), projectFilters: [collisionKey] }),
    ).toEqual({ projectIds: ["dup1"] });
  });
});
