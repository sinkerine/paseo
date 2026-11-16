import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { View } from "react-native";
import { btwConversationKey, useBtwConversationStore } from "./conversation-store";
import { useBtwSelectionTarget } from "./selection-target";
import { useSessionStore } from "@/stores/session-store";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { showWorkspaceTargetBeside } from "@/workspace-tabs/open-beside";
import { selectBtwThread, useBtwThread } from "./select";
import { btwTabTarget, revealBtwTab } from "./tab";
import { createBtwDiscovery } from "./discovery";
import { refreshBtwOnConnect } from "./refresh-on-connect";

export function BtwAutoOpen({
  serverId,
  workspaceId,
  agentId,
  selectionTarget,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  selectionTarget: RefObject<View | null>;
}): null {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const thread = useBtwThread(serverId, agentId);
  const insert = useCallback(
    (text: string) => {
      if (!useBtwConversationStore.getState().insert(btwConversationKey(serverId, agentId), text))
        return false;
      revealBtwTab({
        workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
        agentId,
      });
      return true;
    },
    [serverId, workspaceId, agentId],
  );
  useBtwSelectionTarget({ target: thread ? selectionTarget : undefined, onInsert: insert });
  const discovery = useRef(createBtwDiscovery());
  useEffect(() => {
    if (!client) return;
    return refreshBtwOnConnect(
      client,
      serverId,
      agentId,
      () => {
        // An existing thread at the first successful list is a baseline, not a new conversation.
        const prefix = `${serverId}\0${agentId}\0`;
        const rows = [...useProviderSubagentStore.getState().descriptors]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, row]) => row);
        const current = selectBtwThread(rows);
        discovery.current.baseline(current?.id ?? null);
      },
      () => {},
    );
  }, [client, serverId, agentId]);
  useEffect(() => {
    if (!discovery.current.observe(thread?.id ?? null)) return;
    showWorkspaceTargetBeside({
      workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
      target: btwTabTarget(agentId),
    });
  }, [thread, serverId, workspaceId, agentId]);
  return null;
}
