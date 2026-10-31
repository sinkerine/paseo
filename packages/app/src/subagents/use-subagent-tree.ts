import equal from "fast-deep-equal";
import { useEffect, useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { usePendingArchiveAgentKeys } from "@/hooks/use-archive-agent";
import { useSessionStore } from "@/stores/session-store";
import { refreshProviderSubagents, useProviderSubagentStore } from "./provider-store";
import {
  createSubagentsForParentSelector,
  selectProviderSubagentDescendants,
  type useSubagentsForParent,
  type SubagentRow,
} from "./select";
import { layoutSubagentTree, SUBAGENT_TREE_MAX_DEPTH, type SubagentTreeRow } from "./tree";

type SelectSubagentsParams = Parameters<typeof useSubagentsForParent>[0];
type ProviderSubagentStoreSnapshot = ReturnType<typeof useProviderSubagentStore.getState>;

interface SubagentTrackDirectRowsParams {
  rows: SubagentRow[];
  treeRows: readonly SubagentTreeRow[];
  ownerSubagentId: string | null;
}

export function resolveSubagentTrackDirectRows({
  rows,
  treeRows,
  ownerSubagentId,
}: SubagentTrackDirectRowsParams): SubagentRow[] {
  const directIds = new Set(rows.filter((row) => row.kind === "provider").map((row) => row.id));
  const rescued = treeRows.flatMap(({ row, depth }) => {
    if (row.kind !== "provider" || depth !== 0 || directIds.has(row.id)) return [];
    // Promoted orphans can open from the tree but never count as the owner's direct children.
    return row.parentSubagentId === ownerSubagentId ? [row] : [];
  });
  if (rescued.length === 0) return rows;
  const visible = [...rows, ...rescued];
  visible.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return visible;
}

export function useSubagentTreeForParent(params: SelectSubagentsParams): SubagentTreeRow[] {
  const { serverId, parentAgentId, providerParentSubagentId } = params;
  const pendingArchiveIds = usePendingArchiveAgentKeys();
  const selectPaseoRows = useMemo(
    () => createSubagentsForParentSelector({ serverId, parentAgentId }, pendingArchiveIds),
    [serverId, parentAgentId, pendingArchiveIds],
  );
  const paseoRows = useStoreWithEqualityFn(useSessionStore, selectPaseoRows, equal);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagents === true,
  );
  const nestingSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagentNesting === true,
  );
  const selectProviderRows = useMemo(() => {
    const selectionParams = { serverId, parentAgentId, providerParentSubagentId };
    let previousDescriptors: ProviderSubagentStoreSnapshot["descriptors"] | null = null;
    let previousHiddenFromTrack: ProviderSubagentStoreSnapshot["hiddenFromTrack"] | null = null;
    let previousRows: ReturnType<typeof selectProviderSubagentDescendants> = [];
    return (state: ProviderSubagentStoreSnapshot) => {
      // Timeline updates preserve these references but still invoke store selectors.
      const unchanged =
        previousDescriptors === state.descriptors &&
        previousHiddenFromTrack === state.hiddenFromTrack;
      if (unchanged) return previousRows;
      const nextRows = selectProviderSubagentDescendants(
        state,
        selectionParams,
        supported,
        nestingSupported,
      );
      if (!equal(previousRows, nextRows)) previousRows = nextRows;
      previousDescriptors = state.descriptors;
      previousHiddenFromTrack = state.hiddenFromTrack;
      return previousRows;
    };
  }, [serverId, parentAgentId, providerParentSubagentId, supported, nestingSupported]);
  const providerRows = useStoreWithEqualityFn(useProviderSubagentStore, selectProviderRows, equal);
  const prefix = `${serverId}\0${parentAgentId}\0`;
  const selectExpansionEntries = useMemo(() => {
    let previousExpansion: ProviderSubagentStoreSnapshot["trackExpansion"] | null = null;
    let previousEntries: Array<[string, boolean]> = [];
    return (state: ProviderSubagentStoreSnapshot) => {
      if (previousExpansion === state.trackExpansion) return previousEntries;
      const nextEntries = [...state.trackExpansion].filter(([key]) => key.startsWith(prefix));
      if (!equal(previousEntries, nextEntries)) previousEntries = nextEntries;
      previousExpansion = state.trackExpansion;
      return previousEntries;
    };
  }, [prefix]);
  const expansionEntries = useStoreWithEqualityFn(
    useProviderSubagentStore,
    selectExpansionEntries,
    equal,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);

  useEffect(() => {
    if (!client || !supported) return;
    void refreshProviderSubagents(client, serverId, parentAgentId).catch(() => undefined);
  }, [client, parentAgentId, serverId, supported]);

  return useMemo(() => {
    const expansion = new Map<string, boolean>();
    for (const [key, expanded] of expansionEntries) {
      expansion.set(key.slice(prefix.length), expanded);
    }
    const rows = providerParentSubagentId ? [...providerRows] : [...paseoRows, ...providerRows];
    rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    return layoutSubagentTree({
      rows,
      expansion,
      ownerSubagentId: providerParentSubagentId ?? null,
      maxDepth: SUBAGENT_TREE_MAX_DEPTH,
    });
  }, [expansionEntries, paseoRows, prefix, providerParentSubagentId, providerRows]);
}
