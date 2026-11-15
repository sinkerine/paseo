import type { ClientNotificationScope } from "@getpaseo/protocol/messages";
import { resolveSidebarServerIds } from "@/hooks/sidebar-workspaces-view-model";
import {
  selectProjectViewPlacements,
  selectWorkspaceDirectoryServerIds,
  type ProjectViewPlacement,
  type SessionsSnapshot,
} from "@/stores/session-store-hooks/selectors";
import { resolveActiveProjectFilters } from "./sidebar-project-filter";

export function deriveHostNotificationScope(input: {
  serverId: string;
  sidebarServerIds: readonly string[];
  directoryServerIds: readonly string[];
  projects: readonly ProjectViewPlacement[];
  projectFilters: readonly string[];
}): ClientNotificationScope | undefined {
  const { serverId, sidebarServerIds, directoryServerIds, projects, projectFilters } = input;
  if (!sidebarServerIds.includes(serverId)) return { projectIds: [] };
  if (projectFilters.length === 0) return undefined;
  // Pinned keys cannot be treated as stale before this host has a directory to resolve them against.
  if (!directoryServerIds.includes(serverId)) return { projectIds: [] };
  const viewKeys = new Set(projects.map((project) => project.viewKey));
  const activeFilters = resolveActiveProjectFilters(projectFilters, viewKeys);
  if (activeFilters.length === 0) return undefined;
  const included = new Set(activeFilters);
  const projectIds = new Set<string>();
  for (const project of projects) {
    if (!included.has(project.viewKey)) continue;
    for (const host of project.hosts) {
      if (host.serverId === serverId) projectIds.add(host.projectId);
    }
  }
  return { projectIds: [...projectIds].sort() };
}

export function selectHostNotificationScope(input: {
  serverId: string;
  allServerIds: readonly string[];
  hostRegistryLoaded: boolean;
  hostFilters: readonly string[];
  projectFilters: readonly string[];
  sessions: SessionsSnapshot;
}): ClientNotificationScope | undefined {
  const sidebarServerIds = resolveSidebarServerIds(input);
  const directoryServerIds = selectWorkspaceDirectoryServerIds(input.sessions, sidebarServerIds);
  const projects = selectProjectViewPlacements(input.sessions, directoryServerIds);
  return deriveHostNotificationScope({
    serverId: input.serverId,
    sidebarServerIds,
    directoryServerIds,
    projects,
    projectFilters: input.projectFilters,
  });
}
