import type { ClientNotificationScope } from "@getpaseo/protocol/messages";
import { useMemo, useRef } from "react";
import equal from "fast-deep-equal";
import { deriveHostNotificationScope } from "@/components/sidebar/sidebar-notification-scope";
import { useHosts, useHostRegistryLoaded } from "@/runtime/host-runtime";
import {
  useProjectViewPlacements,
  useWorkspaceDirectoryServerIds,
} from "@/stores/session-store-hooks";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { resolveSidebarServerIds } from "./sidebar-workspaces-view-model";

export function useHostNotificationScope(serverId: string): ClientNotificationScope | undefined {
  const hosts = useHosts();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const allServerIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const sidebarServerIds = useMemo(
    () => resolveSidebarServerIds({ allServerIds, hostFilters, hostRegistryLoaded }),
    [allServerIds, hostFilters, hostRegistryLoaded],
  );
  const directoryServerIds = useWorkspaceDirectoryServerIds(sidebarServerIds);
  const projects = useProjectViewPlacements(directoryServerIds);
  const scope = deriveHostNotificationScope({
    serverId,
    sidebarServerIds,
    directoryServerIds,
    projects,
    projectFilters,
  });
  const previous = useRef(scope);
  if (!equal(previous.current, scope)) previous.current = scope;
  return previous.current;
}
